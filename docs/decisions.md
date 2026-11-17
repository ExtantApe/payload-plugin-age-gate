# Decisions

- 2026-11-10: built as its own agnostic plugin (the owner's rule: "they should be their own agnostic plugins that aren't dependent on each other but work seamlessly"). It knows nothing about sign-up, guardians or roles. The first site that used it wires it into its sign-up plugin through `checks`.
- 2026-11-10 (owner): 13 and up, or the place's age of digital consent; the birth date is never stored; a minor isn't one indefinitely; only staff set it after sign-up.
- The ages table isn't legal advice and hasn't been checked by counsel. Each site using the plugin has it checked for the places it serves.
- 2026-11-13: moved to the ExtantApe GitHub organization and the `@extantape` npm scope at the same version. EXTANT APE owns its reusable tools and licenses them to the platform. The earlier package name is deprecated with a pointer here, and GitHub redirects the old repository address.
- 2026-11-17: after a security read, a stored or cookie date is year-only (a January) rather than a month, because a month plus country gives away a child's birth month. Accepted cost: up to about 12 months longer as a minor, never shorter. `applyAgeGate` opens its own transaction when given no `req` instead of requiring one, because the update and its audit entry belong together and a sign-up that forgets `req` should not skip the audit.
