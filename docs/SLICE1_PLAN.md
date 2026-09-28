# Slice 1 plan: foundation only

## In scope

1. Skeleton: TypeScript on Node 22, pnpm, Vitest, `pg` as the only runtime dependency, plain-SQL
   migrations with a sha256 ledger.
2. Schema (`scopely`): `niche_playbooks`, `issue_codes`, `rule_versions`, `markets`, `businesses`,
   `sources`, `snapshots`, `observations`, `evidence`, `contacts`, `suppression`, `catalog_items`,
   `opportunities`, `opportunity_evidence`, `outcomes`, `verifications`, `messages`, `cost_events`,
   plus the views `v_market_funnel` and `v_opportunity_type_performance`.
3. The Truth Rule as database constraints and triggers (see README).
4. Reference data: two playbooks (aesthetics VALIDATED, UK trades Lead Recovery HYPOTHESIS), issue
   codes, v1 rules, and the three seed services at the prices in the OutboundOS sources, with effort,
   implementation type, margin and close rate left NULL.
5. Golden set: 103 cases from OutboundOS rounds 1 and 2, with verbatim sources, line references,
   NEEDS_BROWSER_CHECK and MUST_NOT_CLAIM.
6. Tests for the 12 data invariants, the golden set and the reference-data labels, run against a
   throwaway local Postgres.
7. CI: the same checks against a `postgres:16` service container.

## Out of scope (Slice 2 or later)

Fetching or rendering sites, check implementations, AI interpretation, discovery, contact
enrichment, message drafting or sending, a UI, any hosted infrastructure.

## Exit criteria

`pnpm check` is green locally and in CI; each guard trigger is shown to be load-bearing by a
mutation check; the commercial safety gate is answered in the Slice 1 report before any Slice 2 work.
