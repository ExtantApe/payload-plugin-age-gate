# Changelog

## Unreleased

Privacy fixes from a security read on 2026-11-17. Raised by Captive Origins (K task and decision: see the pull request).

- **`minorUntil` no longer keeps the birth month.** It is January of the year after the person reaches their age of majority (and the cap is the same for the highest age anywhere), so the stored value, with the country and state, no longer gives the month. It is never earlier than the true date. **Trade-off:** an account counts as a minor for up to about 12 months longer. The "not yet" answer also moves a year on to a January. Month values already stored keep working; `coarsen()` rounds one up to a January.
- **The stay-blocked cookie holds only a year.** It was signed but readable, lasted 400 days and held the month someone could come back from, so anyone on a shared device could read a child's birth month. It now holds the earliest year they may come back (read as January) and a signature. The 400-day lifetime is unchanged, as it still has to outlast a retry. An old cookie with a valid signature still blocks, rounded up to a January; an edited or unsigned one is ignored. `ageCheck`'s `allowedFrom` and `tooYoungMessage` now give a January, so hosts that show "come back from {month}" will show January of a year.
- **`applyAgeGate` without a `req` makes its own request and transaction.** Before, `onEvent` was skipped and the host's audit ran outside the update. Now the update and `onEvent` commit together, and if `onEvent` throws the update is rolled back and the error is rethrown. With a `req`, nothing changes: the host owns the transaction.

Tested: Vitest with a real Payload and an in-memory MongoDB replica set, made-up accounts. `minorUntil` and the consent block are never before the true date for majorities 18 to 21, in all twelve birth months, with December and January boundaries; the cookie value holds no month, tampering and old-format cookies are handled; `applyAgeGate` runs `onEvent` inside a transaction, rolls back on an audit failure and joins a host's `req`.
Not tested: a host's real database and audit collection; sign-up through Sign-up's endpoint; migrating existing accounts with `coarsen()`.
