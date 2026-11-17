import { AGES, ruleFor, type AgeRule } from './ages.js'

/** A month as "YYYY-MM". */
export type YearMonth = `${number}-${string}`

export type AgeResult =
  | { result: 'too-young'; allowedFrom: string }
  | { result: 'minor'; minorUntil: string }
  | { result: 'adult' }
  | { result: 'invalid'; reason: string }

export type AgeInput = {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string
  /** e.g. "AL" for Alabama; optional. */
  region?: string | null
  birthYear: number
  /** 1 to 12. */
  birthMonth: number
  now?: Date
  ages?: Record<string, AgeRule>
  /** The youngest anyone may ever sign up, wherever they are. Default 13. */
  minimumAge?: number
}

const ym = (year: number, month: number): string => {
  // month may be 13 (January of the next year)
  const y = year + Math.floor((month - 1) / 12)
  const m = ((month - 1) % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * Where someone stands, from only their country and birth month and year. The answer itself is never stored by this
 * function, and it never guesses a birthday: without the day, someone is taken to turn a year older only once their
 * birth month is over, so the answer is never older than they are. "From YYYY-MM" means from the first day of that
 * month.
 */
export function ageCheck(input: AgeInput): AgeResult {
  const now = input.now ?? new Date()
  const { birthYear, birthMonth } = input
  if (!Number.isInteger(birthYear) || !Number.isInteger(birthMonth) || birthMonth < 1 || birthMonth > 12) return { result: 'invalid', reason: 'Choose your birth month and year.' }
  if (birthYear > now.getUTCFullYear() || birthYear < now.getUTCFullYear() - 130) return { result: 'invalid', reason: 'Choose your birth month and year.' }
  if (!/^[A-Za-z]{2}$/.test(input.country.trim())) return { result: 'invalid', reason: 'Choose your country.' }
  const rule = ruleFor(input.country, input.region, input.ages ?? AGES)
  const consent = Math.max(rule.consent, input.minimumAge ?? 13)
  // The month in which someone is certainly `age` years old: the month after their birth month, `age` years on.
  const from = (age: number) => ym(birthYear + age, birthMonth + 1)
  // What is handed out and stored is coarser: January of the year after they reach `age`, so the birth month can't be
  // worked back from it. It is never earlier than `from(age)`.
  const coarse = (age: number) => `${birthYear + age + 1}-01`
  const nowYm = ym(now.getUTCFullYear(), now.getUTCMonth() + 1)
  if (nowYm < from(consent)) return { result: 'too-young', allowedFrom: coarse(consent) }
  if (nowYm < from(rule.majority)) return { result: 'minor', minorUntil: coarse(rule.majority) }
  return { result: 'adult' }
}

/** Whether an account with this `minorUntil` is a minor now. No value: an adult. */
export const isMinor = (minorUntil: string | null | undefined, now = new Date()) =>
  Boolean(minorUntil) && ym(now.getUTCFullYear(), now.getUTCMonth() + 1) < (minorUntil as string)

/**
 * Rounds a stored value up to the January on or after it, so no birth month is kept: "2028-02" and "2028-12" become
 * "2029-01", a January stays as it is, and a bare year "2028" is read as "2028-01". Running it twice gives the same
 * answer. Anything else (null, empty, junk, a month 13) gives null, so a caller can refuse it rather than store a guess.
 */
export const coarsen = (value: string | null | undefined): string | null => {
  const m = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/.exec(String(value ?? '').trim())
  if (!m) return null
  const y = Number(m[1])
  return `${!m[2] || m[2] === '01' ? y : y + 1}-01`
}

/**
 * What a "no, not yet" answer moves `minorUntil` to: a year later (a January), but never past `cap`. Both are rounded
 * up to a January first, so an account that still holds a month never writes one back (age-gate#2 review).
 */
export const askAgainUntil = (minorUntil: string, cap: string): string => {
  const until = coarsen(minorUntil)
  if (!until) throw new Error('age-gate: minorUntil must be YYYY-MM.')
  const next = `${Number(until.slice(0, 4)) + 1}-01`
  const c = coarsen(cap)
  return c && c < next ? (c > until ? c : until) : next
}

/** The latest a minor can stay one: January of the year after the highest age of majority anywhere. Year-only. */
export const capFor = (birthYear: number, _birthMonth: number, maxAge: number) => `${birthYear + maxAge + 1}-01`
