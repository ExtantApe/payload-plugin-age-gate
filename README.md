# payload-plugin-age-gate

Age gate for Payload: a neutral birth month and year check at sign-up that stores only how long an account is a minor, from a table of ages by country.

**Status:** early, 0.x. 45 tests pass: the age arithmetic, the cookie, the fields, the adult question and the transactions, against a real Payload 3.92 with an in-memory MongoDB. The picker hasn't been tried in a browser yet, and it isn't in use on any site yet. **The table of ages hasn't been checked by a lawyer.** Have yours check it for the places you serve before you rely on it.

## What it does

- **Asks for birth month and year only, never the day,** and never keeps the answer. A neutral picker starts with nothing chosen and says the answer isn't kept.
- **Answers one of three things**, from the person's country (and region where the age differs, like US states):
  - **Too young:** under the place's age of digital consent, and never under 13. A signed, HttpOnly cookie keeps them blocked until a January, so choosing an older year doesn't get round it. The cookie holds only a year (the earliest year they may come back, read as January), never a birth month.
  - **A minor:** the account stores only `minorUntil` (written YYYY-MM, always a January): the January after they're of age where they live, plus a hidden cap. Nobody can work a birth month back from it. The cost is that an account counts as a minor for up to about 12 months longer than it strictly has to, never shorter.
  - **An adult:** nothing is stored.
- **Never guesses a birthday.** Without the day, someone counts as a year older only once their birth month is over, so the answer is never older than they are. What is stored or put in the cookie is rounded up to the next January, so it is never early.
- **"Are you a legal adult now?"** Once `minorUntil` has passed, the person answers. Yes clears it. No moves it a year on, but never past the highest age of majority anywhere (21), so nobody stays a minor indefinitely.
- **Always a January, whoever writes it.** A month written to `minorUntil` or `minorCap`, by staff, a host or the plugin, is stored as the next January. Anything that isn't a month or a year is refused.
- **Older values keep working.** An account that holds a month from 0.1.2 or earlier still reads as a minor until that month's next January, and its month never goes back out in a response or an audit entry. Saving the account rounds both values. To round them all at once, run `coarsenStoredAges(payload)` once after upgrading: it covers `minorUntil` and `minorCap`, runs in one transaction and is safe to run again. It lists any account whose value can't be read, for staff to fix by hand. An old block cookie with a valid signature still blocks (read as a January), and is replaced with a year cookie when it's next seen.
- **Nobody sets their own status.** Only who you allow with `canSetMinor` (staff) can change `minorUntil`. Every change goes to `onEvent`, for your audit log.
- **Fails closed.** Missing or nonsense answers are refused, not guessed. Where a country's ages differ by region (US states, Canadian provinces) and no region is given, the highest applies.
- **Private.** Only the person and `canSetMinor` can read `minorUntil`. Only an exact `true` from `canSetMinor` counts: see [Access](#access).

**It's self-declared, not verified.** A child can choose a false year or clear their cookies. This checks what people tell you, protectively; it doesn't prove anyone's age.

What a minor may do on your site is up to your access rules: `isMinor(user.minorUntil)`.

## On its own, and with others

**On its own:** it adds `minorUntil` and a hidden cap to your users collection, plus the signed-in adult question. Your own form calls `ageGateCheck` and `applyAgeGate`, and your access rules call `isMinor`. It doesn't depend on any other plugin.

**Works with:**
- **Sign-up:** put `ageGateCheck` in Sign-up's `checks`. It refuses anyone too young, flags a minor for staff, and hands `minorUntil` to the new account as `userData`. The birth month and year go in as `answers`, which Sign-up never stores. The stay-blocked cookie goes back as `setCookies`, which Sign-up sets on its response (Sign-up's next release; with 0.1.0 it's lost). Neither plugin imports the other: the check returns plain values.
- **Guardians:** Guardians' required `isMinor` can read this plugin's field: `(user) => isMinor(user.minorUntil)`.
- **Audit Trail:** pass `onEvent` through Audit Trail's `fromPluginEvent`, so every change to a minor status lands in the tamper-evident trail.

**Family:** It's part of the **Identity** family (a working draft): plugins designed to sit together for accounts and access. The others are Sign-up, MFA, Hats, Guardians, User Controls, Roles and Masq.

## Use

```ts
import { ageGate, ageGateCheck } from '@extantape/payload-plugin-age-gate'

plugins: [
  ageGate({
    secret: process.env.PAYLOAD_SECRET!, // signs the stay-blocked cookie (32+ characters)
    canSetMinor: ({ req }) => isStaff(req.user),
    onEvent: (e) => audit(e), // minor-set, minor-cleared, asked-again
    // ages: { ...AGES, XX: { consent: 13, majority: 18 } }, // after your lawyer's review
  }),
]

// With @extantape/payload-plugin-signup, or your own form:
const check = ageGateCheck({ secret: process.env.PAYLOAD_SECRET! })
// check({ answers: { country, region, birthYear, birthMonth }, req }) → { refuse, setCookies? } | { flag: 'minor', userData } | undefined
// It reads the stay-blocked cookie from req.headers. Too young: set each of setCookies as a Set-Cookie header on your response.
// After creating the user, record a minor with applyAgeGate(payload, { userId, userData, req }).
// The update and your `onEvent` audit entry always commit together: the plugin opens a transaction unless your `req`
// already has one. If `onEvent` throws, the plugin writes the minor flag again on its own and the error reaches you,
// so the account is never left looking like an adult. If your `req` already has a transaction, the create and this
// call share it: when it throws, roll the whole transaction back, so the account isn't left without its flag.
// The fields can't be written through access-checked creates, so passing userData with overrideAccess: false would drop it.
```

The picker, for your form: `import { BirthMonthYear } from '@extantape/payload-plugin-age-gate/client'`. It posts `birthMonth` and `birthYear`, and every word can be replaced for translation.

The adult question: `POST /api/users/age-gate/adult` with `{ "adult": true | false }`, signed in.

## Access

`canSetMinor` decides who is staff, and only an answer of exactly `true` counts, for a signed-in user.
Anything else is a no: `false`, `1`, `'yes'`, an object, or an error thrown or rejected. An error
doesn't escape as a 500: the field is simply left out or left unchanged, as for anyone else who
isn't staff. Payload's field access has no queries, so `canSetMinor`'s answer is never passed to it.

| Field | Staff | The person | Anyone else, or signed out |
|---|---|---|---|
| `minorUntil` | Reads, sets, clears | Reads only | Never sees it |
| `minorCap` | Reads, sets, clears | Never sees it | Never sees it |

The person clears their own status only through the adult question above, and `applyAgeGate`
records a sign-up's result with full access.

A member can't find minors by filtering or sorting on `minorUntil`; a test covers it.

**Keep `createdAt` with staff.** `minorUntil` is a January, but together with when the account was made it narrows the
birth month: an account made in June 2030 that is a minor until January 2031 was born in June or later. Show the two
together only to staff.

**Transactions need MongoDB as a replica set** (Atlas is one). On a standalone server Payload runs without them, so
the update and the audit entry can't roll back together.

## Commands

```bash
npm test          # Vitest, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See `LICENSE`.
