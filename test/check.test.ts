import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { ageCheck, askAgainUntil, blockCookie, blockedUntil, capFor, coarsen, isMinor, maxMajority, ruleFor } from '../src/index.js'

const at = (iso: string) => new Date(`${iso}T12:00:00Z`)

describe('ageCheck: from only a country and a birth month and year', () => {
  it('blocks under 13 anywhere, until the January after they are certainly 13', () => {
    expect(ageCheck({ country: 'US', birthYear: 2014, birthMonth: 3, now: at('2026-11-10') })).toEqual({ result: 'too-young', allowedFrom: '2028-01' })
  })

  it('never takes someone to be older than they are: a birthday this month doesn’t count yet', () => {
    // Born November 2013: some days this month they're 12, so not yet allowed.
    expect(ageCheck({ country: 'US', birthYear: 2013, birthMonth: 11, now: at('2026-11-30') })).toEqual({ result: 'too-young', allowedFrom: '2027-01' })
    expect(ageCheck({ country: 'US', birthYear: 2013, birthMonth: 11, now: at('2026-12-01') }).result).toBe('minor')
  })

  it('uses each country’s age of digital consent: 16 in Germany and Ireland, 14 in Spain and Italy', () => {
    const born = { birthYear: 2011, birthMonth: 1, now: at('2026-11-10') } // 15
    expect(ageCheck({ country: 'DE', ...born }).result).toBe('too-young')
    expect(ageCheck({ country: 'IE', ...born }).result).toBe('too-young')
    expect(ageCheck({ country: 'ES', ...born }).result).toBe('minor')
    expect(ageCheck({ country: 'IT', ...born }).result).toBe('minor')
  })

  it('marks a minor until the month they are certainly of age, by the place’s majority', () => {
    // No state given: the highest of the US's rules (Mississippi, 21), protectively.
    expect(ageCheck({ country: 'US', birthYear: 2010, birthMonth: 6, now: at('2026-11-10') })).toEqual({ result: 'minor', minorUntil: '2032-01' })
    expect(ageCheck({ country: 'US', region: 'AZ', birthYear: 2010, birthMonth: 6, now: at('2026-11-10') })).toEqual({ result: 'minor', minorUntil: '2029-01' })
    expect(ageCheck({ country: 'US', region: 'AL', birthYear: 2010, birthMonth: 6, now: at('2026-11-10') })).toEqual({ result: 'minor', minorUntil: '2030-01' })
    expect(ageCheck({ country: 'US', region: 'MS', birthYear: 2010, birthMonth: 6, now: at('2026-11-10') })).toEqual({ result: 'minor', minorUntil: '2032-01' })
    expect(ageCheck({ country: 'KR', birthYear: 2010, birthMonth: 6, now: at('2026-11-10') })).toEqual({ result: 'minor', minorUntil: '2030-01' })
  })

  it('passes adults, and treats unknown places as consent 13, majority 18', () => {
    expect(ageCheck({ country: 'US', birthYear: 1990, birthMonth: 1, now: at('2026-11-10') })).toEqual({ result: 'adult' })
    expect(ruleFor('ZZ')).toEqual({ consent: 13, majority: 18 })
  })

  it('refuses nonsense rather than guessing', () => {
    expect(ageCheck({ country: 'US', birthYear: 2010, birthMonth: 13 }).result).toBe('invalid')
    expect(ageCheck({ country: 'US', birthYear: 3000, birthMonth: 1 }).result).toBe('invalid')
    expect(ageCheck({ country: 'United States', birthYear: 2000, birthMonth: 1 }).result).toBe('invalid')
    expect(ageCheck({ country: 'US', birthYear: Number.NaN, birthMonth: 1 }).result).toBe('invalid')
  })

  it('a site can raise the minimum, and override any place', () => {
    expect(ageCheck({ country: 'US', birthYear: 2012, birthMonth: 1, now: at('2026-11-10'), minimumAge: 16 }).result).toBe('too-young')
    expect(ageCheck({ country: 'US', birthYear: 2012, birthMonth: 1, now: at('2026-11-10'), ages: { US: { consent: 13, majority: 20 } } })).toEqual({ result: 'minor', minorUntil: '2033-01' })
  })
})

describe('being a minor over time', () => {
  it('isMinor until the stored month, then not', () => {
    expect(isMinor('2028-07', at('2028-06-30'))).toBe(true)
    expect(isMinor('2028-07', at('2028-07-01'))).toBe(false)
    expect(isMinor(null)).toBe(false)
  })

  it('"not yet" moves a year on but never past the cap, which is the highest majority anywhere', () => {
    expect(maxMajority()).toBe(21)
    const cap = capFor(2010, 6, maxMajority())
    expect(cap).toBe('2032-01')
    expect(askAgainUntil('2029-01', cap)).toBe('2030-01')
    expect(askAgainUntil('2031-01', cap)).toBe('2032-01')
    expect(askAgainUntil('2032-01', cap)).toBe('2032-01')
    // An older account that still holds a month: the next value is year-only, and never earlier than a year on.
    expect(askAgainUntil('2028-07', cap)).toBe('2030-01')
  })
})

describe('minorUntil is coarse and never early', () => {
  const trueMajority = (by: number, bm: number, age: number) => by * 12 + (bm - 1) + age * 12 + 1 // months since year 0: the month after the birth month
  const ymIndex = (v: string) => Number(v.slice(0, 4)) * 12 + Number(v.slice(5, 7)) - 1
  const majorities = [...new Set([18, 19, 20, 21])]

  it('is always a January, so no birth month can be worked back from it', () => {
    for (const majority of majorities) for (let bm = 1; bm <= 12; bm++) {
      const r = ageCheck({ country: 'US', birthYear: 2012, birthMonth: bm, now: at('2026-11-10'), ages: { US: { consent: 13, majority } } })
      expect(r.result).toBe('minor')
      const v = (r as { minorUntil: string }).minorUntil
      expect(v).toMatch(/^\d{4}-01$/)
      expect(v).toBe(`${2012 + majority + 1}-01`) // the same for every birth month
    }
  })

  it('is never before the true majority date, in every month, for every age the table supports', () => {
    for (const majority of majorities) for (let bm = 1; bm <= 12; bm++) {
      const r = ageCheck({ country: 'US', birthYear: 2012, birthMonth: bm, now: at('2026-11-10'), ages: { US: { consent: 13, majority } } }) as { minorUntil: string }
      expect(ymIndex(r.minorUntil)).toBeGreaterThanOrEqual(trueMajority(2012, bm, majority))
      expect(ymIndex(r.minorUntil) - trueMajority(2012, bm, majority)).toBeLessThan(12) // at most a year late
    }
  })

  it('treats December and January births correctly at the boundary: a minor to the last day, never an adult early', () => {
    // Born December 2008, majority 18: of age from January 2027. The stored value is that January: the same instant.
    expect(ageCheck({ country: 'US', region: 'AZ', birthYear: 2008, birthMonth: 12, now: at('2026-12-31') })).toEqual({ result: 'minor', minorUntil: '2027-01' })
    expect(ageCheck({ country: 'US', region: 'AZ', birthYear: 2008, birthMonth: 12, now: at('2027-01-01') })).toEqual({ result: 'adult' })
    // Born January 2009: of age from February 2027 by the plugin's own rule; stored as January 2028, so a minor until then.
    expect(ageCheck({ country: 'US', region: 'AZ', birthYear: 2009, birthMonth: 1, now: at('2027-01-15') })).toEqual({ result: 'minor', minorUntil: '2028-01' })
    expect(isMinor('2028-01', at('2027-12-31'))).toBe(true)
    expect(isMinor('2028-01', at('2028-01-01'))).toBe(false)
  })

  it('the consent block is a January too, and never before the true month', () => {
    for (let bm = 1; bm <= 12; bm++) {
      const r = ageCheck({ country: 'DE', birthYear: 2012, birthMonth: bm, now: at('2026-11-10') }) as { result: string; allowedFrom: string }
      expect(r.result).toBe('too-young')
      expect(r.allowedFrom).toBe('2029-01')
      expect(ymIndex(r.allowedFrom)).toBeGreaterThanOrEqual(trueMajority(2012, bm, 16))
    }
  })

  it('coarsen rounds up to a January and leaves a January alone', () => {
    expect(coarsen('2028-01')).toBe('2028-01')
    expect(coarsen('2028-02')).toBe('2029-01')
    expect(coarsen('2028-12')).toBe('2029-01')
  })

  it('an older stored month still reads correctly', () => {
    expect(isMinor('2028-07', at('2028-06-30'))).toBe(true)
    expect(isMinor('2028-07', at('2028-07-01'))).toBe(false)
  })
})

describe('the stay-blocked cookie', () => {
  const secret = 'x'.repeat(40)
  const legacy = (month: string) => `age-gate=${month}.${createHmac('sha256', `age-gate:${secret}`).update(month).digest('base64url')}`

  it('keeps a too-young visitor blocked until the January, and is signed, HttpOnly and Secure', () => {
    const set = blockCookie(secret, '2028-01')
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/Secure/)
    expect(set).toMatch(/SameSite=Lax/)
    const header = set.split(';')[0]!
    expect(blockedUntil(secret, header, at('2026-11-10'))).toBe('2028-01')
    expect(blockedUntil(secret, header, at('2027-12-31'))).toBe('2028-01')
    expect(blockedUntil(secret, header, at('2028-01-01'))).toBeNull()
  })

  it('holds only a year: no birth month can be recovered from the value', () => {
    for (let m = 1; m <= 12; m++) {
      // Whatever month is given, the value is a year and a signature, and a month is only ever rounded up.
      const header = blockCookie(secret, `2028-${String(m).padStart(2, '0')}`).split(';')[0]!
      const value = header.slice('age-gate='.length)
      expect(value).toMatch(/^\d{4}\.[\w-]+$/)
      expect(value).not.toMatch(/\d{4}-\d{2}/)
      expect(blockedUntil(secret, header, at('2026-11-10'))).toBe(m === 1 ? '2028-01' : '2029-01')
    }
    // Two different birth months in one year make the same cookie.
    expect(blockCookie(secret, '2028-01')).toBe(blockCookie(secret, '2028-01'))
    expect(ageCheck({ country: 'DE', birthYear: 2012, birthMonth: 3, now: at('2026-11-10') })).toEqual(ageCheck({ country: 'DE', birthYear: 2012, birthMonth: 9, now: at('2026-11-10') }))
  })

  it('ignores a cookie someone edited, or one signed with another secret', () => {
    const header = blockCookie(secret, '2028-01').split(';')[0]!
    expect(blockedUntil(secret, header.replace('2028', '2020'), at('2019-11-10'))).toBeNull()
    expect(blockedUntil('y'.repeat(40), header, at('2026-11-10'))).toBeNull()
    expect(blockedUntil(secret, 'age-gate=garbage', at('2026-11-10'))).toBeNull()
    expect(blockedUntil(secret, header + '.x', at('2026-11-10'))).toBeNull()
    expect(blockedUntil(secret, 'age-gate=2028.', at('2026-11-10'))).toBeNull()
    expect(blockedUntil(secret, 'age-gate=.abc', at('2026-11-10'))).toBeNull()
  })

  it('an old-format cookie (a month) with a valid signature still blocks, rounded up to a January, never read as a month', () => {
    expect(blockedUntil(secret, legacy('2027-04'), at('2026-11-10'))).toBe('2028-01')
    expect(blockedUntil(secret, legacy('2027-04'), at('2028-01-01'))).toBeNull()
    expect(blockedUntil(secret, legacy('2027-01'), at('2026-12-31'))).toBe('2027-01')
  })

  it('an old-format cookie that was edited or unsigned is refused, so it never blocks or unblocks by forgery', () => {
    expect(blockedUntil(secret, legacy('2027-04').replace('2027-04', '2027-05'), at('2026-11-10'))).toBeNull()
    expect(blockedUntil(secret, 'age-gate=2027-04', at('2026-11-10'))).toBeNull()
    expect(blockedUntil(secret, 'age-gate=2027-13.abc', at('2026-11-10'))).toBeNull()
  })
})
