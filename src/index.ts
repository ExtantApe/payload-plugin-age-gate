import { createHmac, timingSafeEqual } from 'node:crypto'

import type { CollectionConfig, Config, Endpoint, Field, PayloadRequest, Plugin } from 'payload'
import { APIError, commitTransaction, createLocalReq, initTransaction, killTransaction } from 'payload'

import { isStaff } from './access.js'
import { AGES, DEFAULT_RULE, maxMajority, ruleFor, type AgeRule } from './ages.js'
import { ageCheck, askAgainUntil, capFor, coarsen, isMinor, type AgeResult } from './check.js'

export { AGES, DEFAULT_RULE, maxMajority, ruleFor, type AgeRule } from './ages.js'
export { ageCheck, askAgainUntil, capFor, coarsen, isMinor, type AgeInput, type AgeResult } from './check.js'

export type AgeGateEvent = {
  type: 'minor-set' | 'minor-cleared' | 'asked-again'
  user: string
  from: string | null
  to: string | null
  by: 'signup' | 'self' | 'staff' | 'system'
  req: PayloadRequest
}

export type AgeGateOptions = {
  /** The auth collection's slug. Default "users". */
  users?: string
  /** Ages by place; defaults to AGES. Merge your own entries over it after your lawyer's review. */
  ages?: Record<string, AgeRule>
  /** The youngest anyone may sign up anywhere. Default 13. */
  minimumAge?: number
  /**
   * Who may set or clear an account's minor status by hand (staff, for safety). Nobody else ever can. Only an answer
   * of exactly `true` counts, and only for a signed-in user; anything else, a thrown error included, is a no.
   */
  canSetMinor: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
  /** Signs the "too young, come back later" cookie. Use a long random secret (e.g. your app secret). */
  secret: string
  /** Every change to an account's minor status, for your audit log. */
  onEvent?: (event: AgeGateEvent) => void | Promise<void>
}

const COOKIE = 'age-gate'

/** Every entry point that signs or checks a cookie refuses a missing or short secret, not only `ageGate()`. */
function assertSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('age-gate: `secret` must be at least 32 characters.')
}

const sig = (secret: string, value: string) => createHmac('sha256', `age-gate:${secret}`).update(value).digest('base64url')

/**
 * A cookie that keeps a too-young visitor blocked, so picking another year doesn't get round it. It holds only a
 * year: the earliest year they may come back, read as January of it. A month given (`allowedFrom` is "YYYY-MM") is
 * rounded up to the next January, never down, so nobody is let back early and no birth month sits in the cookie.
 */
export function blockCookie(secret: string, allowedFrom: string, secure = true): string {
  assertSecret(secret)
  const until = coarsen(allowedFrom)
  if (!until) throw new Error('age-gate: allowedFrom must be YYYY-MM.')
  const year = until.slice(0, 4)
  const value = `${year}.${sig(secret, year)}`
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}${secure ? '; Secure' : ''}`
}

/**
 * The January ("YYYY-01") a blocked visitor may try again from, if a valid block cookie is present and still in force.
 * A cookie from 0.1.2 and earlier holds a month; if its signature is valid it is still honoured, rounded up to a
 * January, and is never read back as the month. Anything unsigned, edited or unreadable is ignored: the answers given
 * are checked again whatever the cookie says.
 */
export function blockedUntil(secret: string, cookieHeader: string | null | undefined, now = new Date()): string | null {
  return readBlock(secret, cookieHeader, now)?.until ?? null
}

/**
 * Every `age-gate` cookie in the header is checked and the latest valid one wins, so sending an old one beside a newer
 * one doesn't get round the block. `month` is true when that cookie is in the old month format, so it can be replaced.
 */
function readBlock(secret: string, cookieHeader: string | null | undefined, now: Date): { until: string; month: boolean } | null {
  assertSecret(secret)
  const nowYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  let best: { until: string; month: boolean } | null = null
  for (const match of (cookieHeader ?? '').matchAll(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`, 'g'))) {
    const [value, mac, ...rest] = match[1]!.split('.')
    if (!value || !mac || rest.length || !/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(value)) continue
    const expected = Buffer.from(sig(secret, value))
    const got = Buffer.from(mac)
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) continue
    const until = coarsen(value)!
    if (nowYm < until && (!best || until > best.until)) best = { until, month: value.length > 4 }
  }
  return best
}

export type SignupAnswers = { country?: unknown; region?: unknown; birthYear?: unknown; birthMonth?: unknown }

/** What `ageGateCheck` answers: nothing for an adult. */
export type AgeGateCheckResult = { refuse?: string; setCookies?: string[]; flag?: 'minor'; userData?: { minorUntil: string; minorCap: string } } | undefined

/**
 * A sign-up check (for @extantape/payload-plugin-signup's `checks`, or your own form): refuses someone too young,
 * marks a minor with `minorUntil` and `minorCap`, and passes adults. The answers are only read, never stored.
 *
 * It reads the stay-blocked cookie from `req.headers`, and never writes to the request. Refusing someone too young,
 * it returns the cookie to set as `setCookies` (whole `Set-Cookie` values): Sign-up sets them on its response, and
 * your own form should too.
 */
export function ageGateCheck(opts: Pick<AgeGateOptions, 'ages' | 'minimumAge' | 'secret'>) {
  assertSecret(opts.secret)
  return ({ answers, req }: { answers?: SignupAnswers; req: Pick<PayloadRequest, 'headers'> }): AgeGateCheckResult => {
    const blocked = readBlock(opts.secret, req.headers.get('cookie'), new Date())
    // An old cookie that holds a month is swapped for a year-only one, so the month doesn't stay on a shared device.
    if (blocked) return { refuse: tooYoungMessage(blocked.until), ...(blocked.month ? { setCookies: [blockCookie(opts.secret, blocked.until)] } : {}) }
    const a = answers ?? {}
    const result: AgeResult = ageCheck({
      country: String(a.country ?? ''),
      region: a.region ? String(a.region) : null,
      birthYear: Number(a.birthYear),
      birthMonth: Number(a.birthMonth),
      ages: opts.ages,
      minimumAge: opts.minimumAge,
    })
    if (result.result === 'invalid') return { refuse: result.reason }
    if (result.result === 'too-young') return { refuse: tooYoungMessage(result.allowedFrom), setCookies: [blockCookie(opts.secret, result.allowedFrom)] }
    if (result.result === 'minor') {
      const cap = capFor(Number(a.birthYear), Number(a.birthMonth), maxMajority(opts.ages ?? AGES))
      return { flag: 'minor', userData: { minorUntil: result.minorUntil, minorCap: cap } }
    }
    return undefined
  }
}

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
export const tooYoungMessage = (allowedFrom: string) => `Thanks for your interest! You can sign up from ${monthName(allowedFrom)}.`

const validYearMonth = (v: unknown) => (v == null || v === '' || coarsen(String(v)) ? true : 'Use YYYY-MM.')
const toJanuary = ({ value }: { value?: unknown }) => (typeof value === 'string' && value ? (coarsen(value) ?? value) : value)

/** The fields added to the users collection. Nobody can change them through the API except `canSetMinor`. */
function fields(opts: AgeGateOptions): Field[] {
  // Only an exact `true` from `canSetMinor` makes staff; a truthy value or a thrown error is a no, and a
  // site's answer is never handed to Payload as the field's access.
  const staff = ({ req }: { req: PayloadRequest }) => isStaff(opts.canSetMinor, req)
  // Only the person and staff see it: "minor until 2031-04" hints at a birth month (security review, 0.1.0).
  const selfOrStaff = async ({ req, id, doc }: { req: PayloadRequest; id?: string | number; doc?: { id?: unknown } }) =>
    Boolean(req.user && String(req.user.id) === String(id ?? doc?.id)) || (await isStaff(opts.canSetMinor, req))
  return [
    {
      name: 'minorUntil',
      label: 'A minor until',
      type: 'text',
      index: true,
      access: { read: selfOrStaff as never, create: staff, update: staff },
      validate: validYearMonth,
      // Whoever writes it, staff or a host, it is stored as a January: a month given is rounded up, never down.
      hooks: { beforeChange: [toJanuary] },
      admin: { position: 'sidebar', description: 'Set at sign-up from the age check, or by staff for safety. Always a January: a month is rounded up to the next one. Empty: an adult.' },
    },
    {
      name: 'minorCap',
      type: 'text',
      validate: validYearMonth,
      hooks: { beforeChange: [toJanuary] },
      access: { create: staff, update: staff, read: staff },
      admin: { hidden: true },
    },
  ]
}

/** POST /api/<users>/age-gate/adult { adult: boolean }: the person answers "Are you a legal adult now?". */
function adultEndpoint(opts: AgeGateOptions, users: string): Endpoint {
  return {
    path: '/age-gate/adult',
    method: 'post',
    handler: async (req) => {
      if (!req.user || req.user.collection !== users) return Response.json({ errors: [{ message: 'Sign in first.' }] }, { status: 401 })
      const body = (await req.json?.().catch(() => null)) as { adult?: unknown } | null
      const me = (await req.payload.findByID({ collection: users as never, id: req.user.id, depth: 0, overrideAccess: true, req, showHiddenFields: true })) as unknown as { minorUntil?: string | null; minorCap?: string | null }
      if (!me.minorUntil) return Response.json({ adult: true })
      // Only rounded values are used and leave here, for the field, the response and the audit (age-gate#2 review).
      const until = coarsen(me.minorUntil)
      // An unreadable value is left for staff: the account stays a minor rather than be guessed an adult.
      if (!until) return Response.json({ errors: [{ message: 'Please ask the site to check your account.' }] }, { status: 409 })
      // Only asked once the date has come: for an old account, the January its month rounds up to.
      if (isMinor(until)) return Response.json({ errors: [{ message: 'Not yet.' }] }, { status: 400 })
      const cap = coarsen(me.minorCap) ?? until
      const adultNow = body?.adult === true
      const next = adultNow || until >= cap ? null : askAgainUntil(until, cap)
      // The change and its audit entry commit together. If the audit fails, nothing changes and the account stays a minor.
      await inTransaction(req, async () => {
        await req.payload.update({ collection: users as never, id: req.user!.id, data: { minorUntil: next, minorCap: next ? cap : null } as never, overrideAccess: true, req, context: { ageGate: true } })
        await opts.onEvent?.({ type: next ? 'asked-again' : 'minor-cleared', user: String(req.user!.id), from: until, to: next, by: adultNow || next ? 'self' : 'system', req })
      })
      if (adultNow) return Response.json({ adult: true })
      return Response.json({ adult: !next, minorUntil: next })
    },
  }
}

/**
 * Age gate for Payload: a neutral birth month and year check at sign-up that stores only how long an account is a
 * minor. Adds `minorUntil` (and a hidden cap) to your users collection, the "Are you an adult now?" endpoint, and logs
 * every change through `onEvent`. What a minor may do is your access rules' business: use `isMinor(user.minorUntil)`.
 */
export const ageGate =
  (opts: AgeGateOptions): Plugin =>
  (config: Config): Config => {
    const users = opts.users ?? 'users'
    assertSecret(opts.secret)
    const found = (config.collections ?? []).some((c) => c.slug === users)
    if (!found) throw new Error(`age-gate: no "${users}" collection.`)
    return {
      ...config,
      collections: (config.collections ?? []).map((c): CollectionConfig => {
        if (c.slug !== users) return c
        return {
          ...c,
          fields: [...(c.fields ?? []), ...fields(opts)],
          endpoints: [...(c.endpoints || []), adultEndpoint(opts, users)],
          hooks: {
            ...c.hooks,
            afterChange: [
              ...(c.hooks?.afterChange ?? []),
              // Staff changes are logged; the plugin's own changes log themselves.
              async ({ doc, previousDoc, operation, req, context }) => {
                if (context?.ageGate || operation !== 'update' || doc.minorUntil === previousDoc?.minorUntil) return doc
                const from = coarsen(previousDoc?.minorUntil) ?? null
                const to = doc.minorUntil ?? null
                // Rounding an old month up to its January is the plugin's own doing, whoever saved the account.
                if (from === to) return doc
                const type = to ? 'minor-set' : 'minor-cleared'
                await opts.onEvent?.({ type, user: String(doc.id), from, to, by: req.user ? 'staff' : 'system', req })
                return doc
              },
            ],
          },
        }
      }),
      custom: { ...config.custom, ageGate: { users, minimumAge: opts.minimumAge ?? 13 }, ageGateOnEvent: opts.onEvent },
    }
  }

/**
 * Records an age check's result on a new account. Use it after creating the user: the fields can't be written through
 * access-checked creates (only `canSetMinor` may), so a sign-up that passed `userData` with `overrideAccess: false`
 * would otherwise drop the minor flag and treat a child as an adult. This writes with full access, refuses anything
 * that isn't a well-formed YYYY-MM, and logs the change.
 */
export async function applyAgeGate(payload: import('payload').Payload, args: { userId: string | number; userData?: { minorUntil?: string; minorCap?: string } | null; req?: PayloadRequest }) {
  const d = args.userData
  if (!d?.minorUntil) return
  const minorUntil = coarsen(d.minorUntil)
  const minorCap = d.minorCap ? coarsen(d.minorCap) : minorUntil
  if (!minorUntil || !minorCap) throw new APIError('age-gate: minorUntil and minorCap must be YYYY-MM.', 500)
  const users = (payload.config.custom?.ageGate as { users?: string } | undefined)?.users ?? 'users'
  const onEvent = (payload.config.custom?.ageGateOnEvent as AgeGateOptions['onEvent']) ?? undefined
  const data = { minorUntil, minorCap: minorCap > minorUntil ? minorCap : minorUntil }
  const req = args.req ?? ((await createLocalReq({}, payload)) as PayloadRequest)
  // The update and the host's `onEvent` (its audit entry) commit together. A `req` that already has a transaction
  // keeps it, and its owner commits; otherwise the plugin opens one, with or without a `req` (age-gate#2 review).
  const started = await initTransaction(req)
  try {
    await payload.update({ collection: users as never, id: args.userId, data: data as never, overrideAccess: true, req, context: { ageGate: true } })
    if (onEvent) await onEvent({ type: 'minor-set', user: String(args.userId), from: null, to: minorUntil, by: 'signup', req })
    if (started) await commitTransaction(req)
  } catch (e) {
    if (!started) throw e
    await killTransaction(req)
    // Fail closed: the account already exists, so rolling back alone would leave it with no flag, which reads as an
    // adult. Write the flag again outside the transaction, then report the failure. A minor without an audit entry
    // is better than a child who passes as an adult. When the caller owns the transaction, rolling back the account
    // with it is the caller's to do (see the README).
    try {
      await payload.update({ collection: users as never, id: args.userId, data: data as never, overrideAccess: true, req: (await createLocalReq({}, payload)) as PayloadRequest, context: { ageGate: true } })
    } catch (again) {
      throw new AggregateError([e, again], 'age-gate: the audit failed and the minor flag could not be written; disable this account.')
    }
    throw e
  }
}

/**
 * Rounds every stored `minorUntil` and `minorCap` up to a January, for accounts made before 0.2.0, in one transaction.
 * Safe to run again: values already year-only are left alone. An account with a value that can't be read is left as
 * it is (it still reads as a minor) and listed in `unreadable` for staff to fix by hand. Rounding isn't a change of status, so it sends
 * no `onEvent`.
 */
export async function coarsenStoredAges(payload: import('payload').Payload, args: { req?: PayloadRequest } = {}) {
  const users = (payload.config.custom?.ageGate as { users?: string } | undefined)?.users ?? 'users'
  const req = args.req ?? ((await createLocalReq({}, payload)) as PayloadRequest)
  const started = await initTransaction(req)
  const result = { checked: 0, changed: 0, unreadable: [] as string[] }
  try {
    const { docs } = await payload.find({ collection: users as never, where: { or: [{ minorUntil: { exists: true } }, { minorCap: { exists: true } }] }, pagination: false, depth: 0, overrideAccess: true, showHiddenFields: true, req, select: { minorUntil: true, minorCap: true } as never })
    for (const doc of docs as unknown as { id: string | number; minorUntil?: string | null; minorCap?: string | null }[]) {
      result.checked++
      const data: Record<string, string> = {}
      let readable = true
      for (const key of ['minorUntil', 'minorCap'] as const) {
        const v = doc[key]
        if (!v) continue
        const c = coarsen(v)
        if (!c) readable = false
        else if (c !== v) data[key] = c
      }
      // An account with a value that can't be read is left whole, for staff: the field's own check would refuse it.
      if (!readable) result.unreadable.push(String(doc.id))
      if (!readable || !Object.keys(data).length) continue
      await payload.update({ collection: users as never, id: doc.id, data: data as never, overrideAccess: true, req, context: { ageGate: true } })
      result.changed++
    }
    if (started) await commitTransaction(req)
  } catch (e) {
    if (started) await killTransaction(req)
    throw e
  }
  return result
}

/** Runs `work` in the request's transaction, opening (and committing or rolling back) one if it has none. */
async function inTransaction(req: PayloadRequest, work: () => Promise<void>) {
  const started = await initTransaction(req)
  try {
    await work()
    if (started) await commitTransaction(req)
  } catch (e) {
    if (started) await killTransaction(req)
    throw e
  }
}

/** For your own check outside sign-up (e.g. an invite form): throws a plain refusal when the answers aren't allowed. */
export function assertAllowedAge(input: Parameters<typeof ageCheck>[0]): AgeResult {
  const r = ageCheck(input)
  if (r.result === 'invalid') throw new APIError(r.reason, 400, null, true)
  if (r.result === 'too-young') throw new APIError(tooYoungMessage(r.allowedFrom), 403, null, true)
  return r
}
