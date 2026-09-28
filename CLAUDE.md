# CLAUDE.md: Scopely operating rules

Read `README.md` first. `docs/SLICE1_PLAN.md` records what Slice 1 is and is not.

## Hard rules

1. **Truth Rule.** Never write a value that was not measured or supplied by a person with a
   basis. Revenue, traffic, conversion rate, leads lost, delivery effort, margin and close rate are
   `NULL` until an outcome or a recorded basis exists. Do not add a column default that invents one.
2. **Observation states are OBSERVED, INFERRED, NOT_OBSERVABLE.** `NOT_OBSERVABLE` never becomes
   evidence, a defect or a message claim. `INFERRED` never backs an `OBSERVED` claim.
3. **VALIDATED is earned from the golden set.** Mark an issue code, rule or playbook `VALIDATED`
   only with a `validation_basis` citing golden case ids that hold an OBSERVED finding. Commercial
   proof (`commercial_status = PROVEN`) needs recorded outcomes, not detection accuracy.
4. **Never claim CLIENT_REQUIRED work was completed by us.** The database refuses it, so do not
   route around the guard.
5. **Outcomes are append-only.** Correct a mistaken win or loss with a `voided` outcome that
   names it (`corrects_outcome_id`, reason in `notes`), then record the right one. Never UPDATE.
6. **Every rule change is a new `rule_versions` row.** Never edit a rule that findings cite.
7. **Applied migrations are immutable.** The runner stores a sha256 and refuses an edited file.
   Add `NNN_name.sql` instead.
8. **OutboundOS is read-only.** Golden sources are copied into `fixtures/golden/sources/` with
   their commit SHA. Never write to the OutboundOS repository.
9. **Do not fork or modify Huntly.** Copy patterns only, and adapt them (see below).
10. **No cloud resources and no outbound contact with businesses** until a slice explicitly
    authorises it. Nothing may send a message without a recorded human approval (`approved_at`).
11. **Never log page HTML, message bodies, contact details or credentials.** Log ids.

## Tests

- `pnpm check` must pass. Every Truth Rule guard has a test, and every guard trigger was
  mutation-checked in Slice 1 (dropping any one fails at least one test). Keep it that way:
  a new guard needs a test that fails when the guard is removed.
- `golden.test.ts` rebuilds the golden set and compares it with the committed file. After editing
  `annotations.json`, run `pnpm golden:build` and review the diff.

## Huntly patterns to copy in Slice 2 (read, adapt, do not import)

| Need | Huntly source (`huntly-ai-backend`) |
|---|---|
| SSRF-safe fetch (DNS pinning, private-range refusal, redirect re-check, size cap) | `src/urlguard.js` |
| AI provider seam (one interface, swappable provider, no provider SDK sprawl) | `src/ai/providers.js` |
| Per-call metering (write a `cost_events` row per fetch, render or LLM call) | `src/metering.js` |
| Kill switch (one flag stops all outbound work) | `src/killswitch.js` |

## Scope discipline

Build only what helps to find a better prospect, prove a better opportunity, sell a service,
deliver it, verify the result, or learn which opportunities make money. Do not start the next
slice without an explicit go-ahead.
