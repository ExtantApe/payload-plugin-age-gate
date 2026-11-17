# Changelog

## Unreleased

Privacy fixes from a security read on 2026-11-17. Raised by Captive Origins (K task and decision: see the pull request).

- **`minorUntil` no longer keeps the birth month.** It is January of the year after the person reaches their age of majority (and the cap is the same for the highest age anywhere), so the stored value, with the country and state, no longer gives the month. It is never earlier than the true date. **Trade-off:** an account counts as a minor for up to about 12 months longer. The "not yet" answer also moves a year on to a January. Month values already stored keep working; `coarsen()` rounds one up to a January.
- **The stay-blocked cookie holds only a year.** It was signed but readable, lasted 400 days and held the month someone could come back from, so anyone on a shared device could read a child's birth month. It now holds the earliest year they may come back (read as January) and a signature. The 400-day lifetime is unchanged, as it still has to outlast a retry. An old cookie with a valid signature still blocks, rounded up to a January; an edited or unsigned one is ignored. `ageCheck`'s `allowedFrom` and `tooYoungMessage` now give a January, so hosts that show "come back from {month}" will show January of a year.
- **`applyAgeGate` without a `req` makes its own request and transaction.** Before, `onEvent` was skipped and the host's audit ran outside the update. Now the update and `onEvent` commit together, and if `onEvent` throws the update is rolled back and the error is rethrown. With a `req`, nothing changes: the host owns the transaction.

Fixes from the EXTANT APE review of the first pass (age-gate#2, 2026-11-17):

- **An old account never writes its month back.** `askAgainUntil` rounds both its values up to a January, and the adult question reads `minorUntil` and `minorCap` rounded, for the field, the response and the audit. An old account is asked once its month's next January has come.
- **Fails closed when the audit fails.** If `onEvent` throws in `applyAgeGate`, the transaction is rolled back and the minor flag is written again on its own before the error is rethrown, so the new account never reads as an adult. If that write fails too, the error says to disable the account. In the adult question, a failed audit changes nothing, so the account stays a minor.
- **The audit never carries the old month.** `from` is rounded in every event.
- **Always one transaction.** `applyAgeGate` and the adult question open a transaction unless the `req` already has one, and leave a host's open transaction for the host to commit.
- **Always a January.** Both fields round any month written to them up to a January, whoever writes it, and refuse anything else.
- **`coarsen()` is safe on anything.** Null, empty or junk gives null, and a bare year is read as its January, so running it twice changes nothing. **Breaking:** it now returns `string | null`.
- **`coarsenStoredAges(payload)`** rounds every stored `minorUntil` and `minorCap` in one transaction, safe to run twice, and lists accounts it can't read.
- **The secret is checked everywhere.** `ageGateCheck`, `blockCookie` and `blockedUntil` throw on a missing secret or one under 32 characters.
- **Cookies:** with several `age-gate` cookies, the latest valid block wins. An old month cookie is replaced with a year cookie when it's seen.
- **README:** keep `createdAt` with staff, since with `minorUntil` it narrows the birth month; transactions need a replica set.

Tested: Vitest with a real Payload and an in-memory MongoDB replica set, made-up accounts. `minorUntil` and the consent block are never before the true date for majorities 18 to 21, in all twelve birth months, with December and January boundaries; the cookie value holds no month, tampering and old-format cookies are handled; `applyAgeGate` runs `onEvent` inside a transaction, rolls back on an audit failure and joins a host's `req`.
Also tested (age-gate#2): an old-format account through four "not yet" answers never shows a month in the field, the response or the audit; an audit failure leaves a new account a minor and changes nothing in the adult question; a host `req` with no transaction gets one, and one with a transaction is joined and left open; staff writing a month stores a January; `coarsenStoredAges` run twice; a member filtering or sorting on `minorUntil` learns nothing.
Not tested: a host's real database and audit collection; sign-up through Sign-up's endpoint; a standalone MongoDB without transactions.
