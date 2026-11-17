import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, commitTransaction, createLocalReq, initTransaction, getPayload, handleEndpoints, type Endpoint, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ageGate, ageGateCheck, applyAgeGate, coarsenStoredAges, type AgeGateEvent } from '../src/index.js'

type U = { id: string; email: string; role: string; minorUntil?: string | null; minorCap?: string | null }
let payload: Payload
let mongo: MongoMemoryReplSet
const SECRET = 's'.repeat(40)
const events: AgeGateEvent[] = []
/** When set, what `canSetMinor` answers instead of the site's rule (staff by role). */
let onEventHook: ((e: AgeGateEvent) => unknown) | null = null
let setMinorAnswer: (() => unknown) | null = null
let staff: U
let kid: U
let other: U

const reqAs = async (user: U | null, headers = new Headers()) => {
  const req = (await createLocalReq({ user: (user ? { ...user, collection: 'users' } : undefined) as never }, payload)) as PayloadRequest
  if (!user) req.user = null
  ;(req as { headers: Headers }).headers = headers
  return req
}
const adult = async (user: U, adultAnswer: boolean) => {
  const ep = (payload.collections.users!.config.endpoints as Endpoint[]).find((e) => e.path === '/age-gate/adult')!
  const req = await reqAs(user)
  ;(req as { json: () => Promise<unknown> }).json = async () => ({ adult: adultAnswer })
  return ep.handler(req)
}
/** Writes straight to the database, past the plugin's hooks: how an account from before 0.2.0 looks. */
const legacy = async (u: U, values: Record<string, string | null>) => {
  await (payload.db as unknown as { collections: Record<string, { updateOne: (q: object, u: object) => Promise<unknown> }> }).collections.users!.updateOne({ _id: u.id }, { $set: values })
}
const fresh = async (u: U) => (await payload.findByID({ collection: 'users', id: u.id, overrideAccess: true, showHiddenFields: true, depth: 0 })) as unknown as U

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('agegate'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, access: { create: () => true, update: () => true, read: () => true }, fields: [{ name: 'role', type: 'select', options: ['staff', 'member'], defaultValue: 'member' }] }],
      plugins: [ageGate({ secret: SECRET, canSetMinor: ((args: { req: PayloadRequest }) => (setMinorAnswer ? setMinorAnswer() : (args.req.user as unknown as U | null)?.role === 'staff')) as never, onEvent: async (e) => { events.push(e); await onEventHook?.(e) } })],
    }),
  })
  staff = (await payload.create({ collection: 'users', data: { email: 'staff@example.invalid', password: 'pw-staff-long', role: 'staff' } as never })) as unknown as U
  kid = (await payload.create({ collection: 'users', data: { email: 'kid@example.invalid', password: 'pw-kid-long' } as never })) as unknown as U
  other = (await payload.create({ collection: 'users', data: { email: 'other@example.invalid', password: 'pw-other-long' } as never })) as unknown as U
})

afterAll(async () => {
  await payload?.destroy?.()
  await mongo?.stop()
})

describe('the age gate on a users collection', () => {
  it('stores nothing about age except "minor until" and a hidden cap; nobody but staff can set them', async () => {
    const fields = payload.collections.users!.config.fields.map((f) => ('name' in f ? f.name : null))
    expect(fields).toEqual(expect.arrayContaining(['minorUntil', 'minorCap']))
    expect(fields).not.toEqual(expect.arrayContaining(['birthYear', 'birthMonth', 'birthDate', 'age']))
    // The person themselves can't make themselves an adult (or a minor) through the API.
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2030-01' } as never, overrideAccess: true })
    const own = await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: null } as never, user: { ...kid, collection: 'users' } as never, overrideAccess: false })
    expect((own as unknown as U).minorUntil).toBe('2030-01')
    // Staff can, and it's logged as theirs.
    const byStaff = await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2031-01' } as never, user: { ...staff, collection: 'users' } as never, overrideAccess: false })
    expect((byStaff as unknown as U).minorUntil).toBe('2031-01')
    expect(events.at(-1)).toMatchObject({ type: 'minor-set', from: '2030-01', to: '2031-01', by: 'staff' })
  })

  it('the sign-up check: refuses and sets the stay-blocked cookie when too young, marks a minor, passes an adult', async () => {
    const check = ageGateCheck({ secret: SECRET })
    const young = await reqAs(null)
    const tooYoung = check({ answers: { country: 'US', birthYear: new Date().getUTCFullYear() - 10, birthMonth: 1 }, req: young })
    expect(tooYoung?.refuse).toMatch(/You can sign up from/)
    // The cookie comes back for the caller to set (Sign-up's endpoint sets it); the request is left alone.
    const cookies = tooYoung?.setCookies ?? []
    expect(cookies).toHaveLength(1)
    const cookie = cookies[0]!
    expect(cookie).toMatch(/^age-gate=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/)
    expect(young.responseHeaders?.get('Set-Cookie') ?? null).toBeNull()
    // Coming back with an older year doesn't get round it.
    const again = await reqAs(null, new Headers({ cookie: cookie.split(';')[0]! }))
    expect(check({ answers: { country: 'US', birthYear: 1980, birthMonth: 1 }, req: again })?.refuse).toMatch(/You can sign up from/)
    const teen = check({ answers: { country: 'US', birthYear: new Date().getUTCFullYear() - 15, birthMonth: 1 }, req: await reqAs(null) })
    expect(teen?.flag).toBe('minor')
    expect(Object.keys(teen?.userData ?? {}).sort()).toEqual(['minorCap', 'minorUntil'])
    expect(check({ answers: { country: 'US', birthYear: 1980, birthMonth: 1 }, req: await reqAs(null) })).toBeUndefined()
    expect(check({ answers: {}, req: await reqAs(null) })?.refuse).toBeTruthy() // fails closed on missing answers
  })

  it('"Are you an adult now?": not before the date; yes clears it; no moves it a year, never past the cap', async () => {
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2999-01', minorCap: '2999-06' } as never, overrideAccess: true })
    expect((await adult(kid, true)).status).toBe(400) // not yet
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2020-01', minorCap: '2022-01' } as never, overrideAccess: true })
    expect(await (await adult(kid, false)).json()).toEqual({ adult: false, minorUntil: '2021-01' })
    await legacy(kid, { minorUntil: '2020-06' }) // an old month: read as 2021-01, so a year on is the cap
    expect(await (await adult(kid, false)).json()).toEqual({ adult: false, minorUntil: '2022-01' })
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2022-01' } as never, overrideAccess: true })
    expect(await (await adult(kid, false)).json()).toEqual({ adult: true, minorUntil: null }) // at the cap: an adult everywhere
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2020-01', minorCap: '2022-01' } as never, overrideAccess: true })
    expect(await (await adult(kid, true)).json()).toEqual({ adult: true })
    expect((await fresh(kid)).minorUntil ?? null).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'minor-cleared', by: 'self' })
  })

  it('only the person and staff can read "minor until"; another member and a signed-out request can’t', async () => {
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2032-01' } as never, overrideAccess: true })
    const as = async (u: U | null) => (await payload.findByID({ collection: 'users', id: kid.id, depth: 0, overrideAccess: false, user: u ? ({ ...u, collection: 'users' } as never) : undefined })) as unknown as U
    expect((await as(kid)).minorUntil).toBe('2032-01')
    expect((await as(staff)).minorUntil).toBe('2032-01')
    expect((await as(other)).minorUntil).toBeUndefined()
    expect((await as(null)).minorUntil).toBeUndefined()
  })

  it('a sign-up that creates with access checks drops the flag, so applyAgeGate records it (and refuses junk)', async () => {
    const userData = { minorUntil: '2031-01', minorCap: '2033-01' }
    const created = (await payload.create({ collection: 'users', data: { email: 'signup@example.invalid', password: 'pw-signup-long', ...userData } as never, overrideAccess: false })) as unknown as U
    expect((await fresh(created)).minorUntil ?? null).toBeNull() // dropped by field access, as the README warns
    await applyAgeGate(payload, { userId: created.id, userData, req: await reqAs(null) })
    expect(await fresh(created)).toMatchObject(userData)
    expect(events.at(-1)).toMatchObject({ type: 'minor-set', to: '2031-01', by: 'signup' })
    // A month handed in is stored, and logged, as the next January.
    await applyAgeGate(payload, { userId: created.id, userData: { minorUntil: '2030-05', minorCap: '2032-05' }, req: await reqAs(null) })
    expect(await fresh(created)).toMatchObject({ minorUntil: '2031-01', minorCap: '2033-01' })
    expect(events.at(-1)).toMatchObject({ type: 'minor-set', to: '2031-01' })
    await expect(applyAgeGate(payload, { userId: created.id, userData: { minorUntil: 'soon' } })).rejects.toThrow(/YYYY-MM/)
  })

  describe('applyAgeGate without a req', () => {
    const make = async (n: string) => (await payload.create({ collection: 'users', data: { email: `${n}@example.invalid`, password: 'pw-noreq-long' } as never })) as unknown as U
    const userData = { minorUntil: '2033-01', minorCap: '2035-01' }

    it('makes its own request, so onEvent runs, inside a transaction', async () => {
      const u = await make('noreq-event')
      let seen: unknown
      onEventHook = (e) => void (seen = e.req.transactionID)
      try {
        await applyAgeGate(payload, { userId: u.id, userData })
      } finally {
        onEventHook = null
      }
      expect(events.at(-1)).toMatchObject({ type: 'minor-set', user: String(u.id), to: '2033-01', by: 'signup' })
      expect(seen).toBeTruthy() // the audit ran in the update's transaction
      expect(await fresh(u)).toMatchObject(userData)
    })

    it('when the audit fails, the account still comes out a minor, never an adult, and the failure is reported', async () => {
      const u = await make('noreq-rollback')
      onEventHook = () => {
        throw new Error('audit down')
      }
      try {
        await expect(applyAgeGate(payload, { userId: u.id, userData })).rejects.toThrow('audit down')
      } finally {
        onEventHook = null
      }
      expect(await fresh(u)).toMatchObject(userData) // age-gate#2 review, blocker 2: fails closed
    })

    it('with a req from the host that has no transaction, still puts the update and the audit in one', async () => {
      const u = await make('noreq-host')
      const req = await reqAs(null)
      expect(req.transactionID).toBeFalsy()
      let seenId: unknown
      onEventHook = (e) => void (seenId = e.req.transactionID)
      try {
        await applyAgeGate(payload, { userId: u.id, userData, req })
      } finally {
        onEventHook = null
      }
      expect(seenId).toBeTruthy()
      expect(await fresh(u)).toMatchObject(userData)
    })

    it('with a req whose transaction the host opened, joins it and leaves the commit to the host', async () => {
      const u = await make('host-tx')
      const req = await reqAs(null)
      expect(await initTransaction(req)).toBe(true)
      const id = req.transactionID
      let seenId: unknown
      onEventHook = (e) => void (seenId = e.req.transactionID)
      try {
        await applyAgeGate(payload, { userId: u.id, userData, req })
      } finally {
        onEventHook = null
      }
      expect(seenId).toBe(id)
      expect(req.transactionID).toBe(id) // still open: the plugin didn't commit it
      expect((await fresh(u)).minorUntil ?? null).toBeNull() // not visible outside the host's transaction yet
      await commitTransaction(req)
      expect(await fresh(u)).toMatchObject(userData)
    })
  })

  describe('accounts from before 0.2.0, which still hold a month (age-gate#2 review)', () => {
    it('"not yet" never writes a month back to the field, the response or the audit', async () => {
      const u = (await payload.create({ collection: 'users', data: { email: 'old-month@example.invalid', password: 'pw-old-long' } as never })) as unknown as U
      await legacy(u, { minorUntil: '2020-05', minorCap: '2023-05' })
      for (let i = 0; i < 4; i++) {
        const res = (await (await adult(u, false)).json()) as { minorUntil: string | null }
        const stored = await fresh(u)
        for (const v of [res.minorUntil, stored.minorUntil, stored.minorCap, events.at(-1)!.from, events.at(-1)!.to]) if (v) expect(v).toMatch(/^\d{4}-01$/)
        if (!res.minorUntil) break
      }
      expect((await fresh(u)).minorUntil ?? null).toBeNull() // reached the cap, rounded up: an adult everywhere
    })

    it('the audit never carries the old month, whoever changes it', async () => {
      const u = (await payload.create({ collection: 'users', data: { email: 'old-audit@example.invalid', password: 'pw-old-long' } as never })) as unknown as U
      await legacy(u, { minorUntil: '2031-04', minorCap: '2033-04' })
      await payload.update({ collection: 'users', id: u.id, data: { minorUntil: '2035-01' } as never, user: { ...staff, collection: 'users' } as never, overrideAccess: false })
      expect(events.at(-1)).toMatchObject({ type: 'minor-set', from: '2032-01', to: '2035-01', by: 'staff' })
    })

    it('saving the account for any reason rounds it to a January, and that alone sends no audit event', async () => {
      const u = (await payload.create({ collection: 'users', data: { email: 'old-save@example.invalid', password: 'pw-old-long' } as never })) as unknown as U
      await legacy(u, { minorUntil: '2031-04', minorCap: '2033-04' })
      const before = events.length
      await payload.update({ collection: 'users', id: u.id, data: { role: 'member' } as never, overrideAccess: true })
      expect(await fresh(u)).toMatchObject({ minorUntil: '2032-01', minorCap: '2034-01' })
      expect(events.length).toBe(before)
    })

    it('coarsenStoredAges rounds every old account in one go, is safe to run twice, and leaves unreadable values for staff', async () => {
      const a = (await payload.create({ collection: 'users', data: { email: 'mig-a@example.invalid', password: 'pw-mig-long' } as never })) as unknown as U
      const b = (await payload.create({ collection: 'users', data: { email: 'mig-b@example.invalid', password: 'pw-mig-long' } as never })) as unknown as U
      await legacy(a, { minorUntil: '2030-07', minorCap: '2032-07' })
      await legacy(b, { minorUntil: 'junk', minorCap: '2031' })
      const first = await coarsenStoredAges(payload)
      expect(first.changed).toBeGreaterThanOrEqual(1)
      expect(first.unreadable).toEqual([String(b.id)])
      expect(await fresh(a)).toMatchObject({ minorUntil: '2031-01', minorCap: '2033-01' })
      expect(await fresh(b)).toMatchObject({ minorUntil: 'junk', minorCap: '2031' }) // left whole for staff: it still reads as a minor
      const second = await coarsenStoredAges(payload)
      expect(second.changed).toBe(0)
      expect(await fresh(a)).toMatchObject({ minorUntil: '2031-01', minorCap: '2033-01' })
      await legacy(b, { minorUntil: null, minorCap: null })
    })
  })

  it('staff or a host writing any month stores the next January, and junk is refused', async () => {
    await payload.update({ collection: 'users', id: other.id, data: { minorUntil: '2031-04' } as never, user: { ...staff, collection: 'users' } as never, overrideAccess: false })
    expect((await fresh(other)).minorUntil).toBe('2032-01')
    await payload.update({ collection: 'users', id: other.id, data: { minorUntil: '2031-07', minorCap: '2033-02' } as never, overrideAccess: true })
    expect(await fresh(other)).toMatchObject({ minorUntil: '2032-01', minorCap: '2034-01' })
    await expect(payload.update({ collection: 'users', id: other.id, data: { minorUntil: '2031-13' } as never, overrideAccess: true })).rejects.toThrow()
    await payload.update({ collection: 'users', id: other.id, data: { minorUntil: null, minorCap: null } as never, overrideAccess: true })
  })

  it('"Are you an adult now?": if the audit fails, nothing changes and the account stays a minor', async () => {
    const u = (await payload.create({ collection: 'users', data: { email: 'adult-audit@example.invalid', password: 'pw-adult-long' } as never })) as unknown as U
    await payload.update({ collection: 'users', id: u.id, data: { minorUntil: '2020-01', minorCap: '2022-01' } as never, overrideAccess: true })
    onEventHook = () => {
      throw new Error('audit down')
    }
    try {
      await expect(adult(u, true)).rejects.toThrow('audit down')
      await expect(adult(u, false)).rejects.toThrow('audit down')
    } finally {
      onEventHook = null
    }
    expect(await fresh(u)).toMatchObject({ minorUntil: '2020-01', minorCap: '2022-01' })
  })

  it('a member can’t find minors by filtering or sorting on "minor until"', async () => {
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: '2999-01' } as never, overrideAccess: true })
    const asOther = { overrideAccess: false, user: { ...other, collection: 'users' } as never }
    const filtered = await payload.find({ collection: 'users', where: { minorUntil: { exists: true } }, depth: 0, ...asOther }).then((r) => r.docs.map((d) => String(d.id)), () => 'refused')
    expect(filtered === 'refused' || !filtered.includes(String(kid.id))).toBe(true)
    const all = await payload.find({ collection: 'users', depth: 0, pagination: false, ...asOther })
    const asc = await payload.find({ collection: 'users', sort: 'minorUntil', depth: 0, pagination: false, ...asOther }).then((r) => r.docs.map((d) => String(d.id)), () => 'refused')
    const desc = await payload.find({ collection: 'users', sort: '-minorUntil', depth: 0, pagination: false, ...asOther }).then((r) => r.docs.map((d) => String(d.id)), () => 'refused')
    // Sorting must not move the minor relative to the default order (or must be refused).
    if (asc !== 'refused' && desc !== 'refused') {
      const ids = all.docs.map((d) => String(d.id))
      expect({ asc: asc.indexOf(String(kid.id)), desc: desc.indexOf(String(kid.id)) }).toEqual({ asc: ids.indexOf(String(kid.id)), desc: ids.indexOf(String(kid.id)) })
    }
  })

  it('refuses the adult question signed out', async () => {
    const ep = (payload.collections.users!.config.endpoints as Endpoint[]).find((e) => e.path === '/age-gate/adult')!
    expect((await ep.handler(await reqAs(null))).status).toBe(401)
  })

  it('won’t start with a short secret or a missing users collection', () => {
    expect(() => ageGate({ secret: 'short', canSetMinor: () => false })({ collections: [{ slug: 'users', fields: [] }] } as never)).toThrow(/secret/)
    expect(() => ageGate({ secret: SECRET, canSetMinor: () => false })({ collections: [] } as never)).toThrow(/no "users"/)
  })
})

describe('only an exact yes from canSetMinor (2026-11-11)', () => {
  // Each a no: truthy values, objects (one shaped like a query, which field access must not read as a yes), and errors.
  const noes: [string, () => unknown][] = [
    ['1', () => 1],
    ["'yes'", () => 'yes'],
    ['{}', () => ({})],
    ['a query-shaped object', () => ({ id: { exists: true } })],
    ['a thrown error', () => {
      throw new Error('staff directory down')
    }],
    ['a rejected promise', async () => {
      throw new Error('staff directory down')
    }],
  ]
  const answering = async (answer: () => unknown, body: () => Promise<void>) => {
    setMinorAnswer = answer
    try {
      await body()
    } finally {
      setMinorAnswer = null
    }
  }
  const as = (u: U | null) => ({ overrideAccess: false, user: u ? ({ ...u, collection: 'users' } as never) : undefined })
  let child: U

  beforeAll(async () => {
    child = (await payload.create({ collection: 'users', data: { email: 'child@example.invalid', password: 'pw-child-long' } as never })) as unknown as U
  })

  it('nobody sets, clears or reads another account\'s minor status on anything but true, and a throw is a no, never an error', async () => {
    for (const [label, answer] of noes) {
      await payload.update({ collection: 'users', id: child.id, data: { minorUntil: '2032-01', minorCap: '2034-01' } as never, overrideAccess: true })
      await answering(answer, async () => {
        // Field access drops a refused field without an error, so each call must resolve and change nothing.
        await expect(payload.update({ collection: 'users', id: child.id, data: { minorUntil: null, minorCap: null } as never, ...as(staff) }), label).resolves.toBeTruthy()
        await expect(payload.update({ collection: 'users', id: child.id, data: { minorUntil: null, minorCap: null } as never, ...as(child) }), label).resolves.toBeTruthy()
        const made = (await payload.create({ collection: 'users', data: { email: `made-${noes.findIndex((n) => n[0] === label)}@example.invalid`, password: 'pw-made-long', minorUntil: '2030-01', minorCap: '2030-01' } as never, ...as(staff) })) as unknown as U
        expect((await fresh(made)).minorUntil ?? null, label).toBeNull()
        expect((await fresh(child)).minorUntil, label).toBe('2032-01')
        expect((await fresh(child)).minorCap, label).toBe('2034-01')
        for (const reader of [staff, other, null]) {
          const seen = (await payload.findByID({ collection: 'users', id: child.id, depth: 0, ...as(reader) })) as unknown as U
          expect(seen.minorUntil, `${label} read by ${reader?.email ?? 'signed out'}`).toBeUndefined()
          expect(seen.minorCap, `${label} read by ${reader?.email ?? 'signed out'}`).toBeUndefined()
        }
        // The person still reads their own "minor until", but never the cap.
        const own = (await payload.findByID({ collection: 'users', id: child.id, depth: 0, ...as(child) })) as unknown as U
        expect(own.minorUntil, label).toBe('2032-01')
        expect(own.minorCap, label).toBeUndefined()
      })
    }
    // Signed out is never staff, even when canSetMinor says true.
    await answering(() => true, async () => {
      const seen = (await payload.findByID({ collection: 'users', id: child.id, depth: 0, ...as(null) })) as unknown as U
      expect(seen.minorUntil).toBeUndefined()
      await payload.update({ collection: 'users', id: child.id, data: { minorUntil: null } as never, ...as(null) })
      expect((await fresh(child)).minorUntil).toBe('2032-01')
    })
    // With exactly true, staff read and change both.
    await answering(() => true, async () => {
      const seen = (await payload.findByID({ collection: 'users', id: child.id, depth: 0, ...as(staff) })) as unknown as U
      expect(seen).toMatchObject({ minorUntil: '2032-01', minorCap: '2034-01' })
      await payload.update({ collection: 'users', id: child.id, data: { minorUntil: '2033-01' } as never, ...as(staff) })
      expect((await fresh(child)).minorUntil).toBe('2033-01')
    })
  })

  it('a throw from canSetMinor answers a REST read and update without a 500', async () => {
    await payload.update({ collection: 'users', id: child.id, data: { minorUntil: '2032-01' } as never, overrideAccess: true })
    const { token } = await payload.login({ collection: 'users', data: { email: 'staff@example.invalid', password: 'pw-staff-long' } })
    const rest = (method: string, body?: unknown) =>
      handleEndpoints({
        config: payload.config,
        request: new Request(`http://localhost/api/users/${child.id}`, { method, headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
      })
    await answering(() => {
      throw new Error('staff directory down')
    }, async () => {
      const read = await rest('GET')
      expect(read.status).toBe(200)
      expect(((await read.json()) as U).minorUntil).toBeUndefined()
      const write = await rest('PATCH', { minorUntil: null })
      expect(write.status).toBeLessThan(500)
    })
    expect((await fresh(child)).minorUntil).toBe('2032-01')
  })
})
