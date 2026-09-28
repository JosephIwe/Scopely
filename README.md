# Scopely

Scopely is a commercial opportunity engine for small businesses. It is not an auditor. It finds
a business, observes a real, fixable problem on the business's own site, attaches the
evidence, maps that problem to a service Joseph can sell at a known price, records what happened
commercially, and later verifies the fix against a fresh snapshot.

```
observation → evidence → opportunity → service → price → outcome → verification → learning
```

The metric that matters is **revenue and gross profit per 100 prospects**. It is not the number
of findings or of audits.

## Status: Slice 1 (foundation only)

Slice 1 contains a schema, reference data, a golden benchmark and the tests that hold them to the
Truth Rule. It has **no crawler, no AI, no outreach, and no cloud resources**. Nothing here
contacts a business. See `docs/SLICE1_PLAN.md`.

## The Truth Rule

Scopely never states a number it did not measure. Revenue, traffic, conversion and "leads lost"
are never estimated. Unknown values are stored as `NULL`, and the funnel view reports `NULL`,
not zero. The database enforces this, not the application:

| Rule | Where it is enforced |
|---|---|
| Evidence rests on an observation made on a stored snapshot | `evidence_guard`, FK + NOT NULL |
| Evidence has a URL, verbatim quote, `observed_at` and confidence | column CHECKs |
| `NOT_OBSERVABLE` never becomes evidence or a defect | `observations` CHECKs, `evidence_guard` |
| An `INFERRED` observation cannot back an `OBSERVED` claim | `evidence_guard` |
| An opportunity has at least one evidence record | deferred `opportunity_has_evidence` |
| An opportunity is mapped to a catalog service or explicitly `UNMAPPED` with a reason | CHECK |
| A price comes from the catalog band, or from an explicit override basis | `opportunity_price_guard` |
| Every finding cites a rule version | NOT NULL FK `rule_version_id` |
| Deal value, reply and win dates exist only through an outcome record | `opportunity_projection_guard` + `outcome_project` |
| Outcomes are append-only | `outcomes_append_only` |
| CLIENT_REQUIRED work is never recorded as delivered by us | `outcome_guard` |
| A verification uses a snapshot taken after the evidence | `verification_guard` |

## VALIDATED vs HYPOTHESIS, and commercial status

These are two separate axes, and both are labels on playbooks, issue codes and rules.

- **`validation_status`** answers whether the detection has been seen working on real sites.
  `VALIDATED` requires a `validation_basis` that cites golden-set case ids. A test fails if an
  issue code is marked VALIDATED without an OBSERVED golden finding, or the other way round.
- **`commercial_status`** answers whether anyone has paid for it. Every catalog item and every
  playbook is `UNPROVEN` today, because no reply, win or delivery has been recorded anywhere.

The London aesthetics playbook is `VALIDATED` / `UNPROVEN`. The UK trades Lead Recovery playbook
is `HYPOTHESIS` / `UNPROVEN`.

## Niche-agnostic model

A **market** is a playbook plus geography: `country_code`, `region`, `city`, `postal_area`,
`timezone`, `currency`, `vertical` and `subvertical`. Its `purpose` is `benchmark`, `experiment`
or `production`. London aesthetics is the benchmark. UK trades is the first experiment. The tests
include a Toronto/CAD market to prove nothing is hard-coded to the UK or to GBP.

## Golden set

`fixtures/golden/` holds 103 cases from two historical OutboundOS prospecting rounds, from
verbatim copies of the source files with their commit SHAs and sha256 hashes. Every finding
cites its source file and line, and the quoted text is re-found there by a test. Ambiguous cases
are `NEEDS_BROWSER_CHECK`, never guessed. Claims the historical work withdrew are
`MUST_NOT_CLAIM`, so Scopely is also tested on what it must not say.

```
pnpm golden:build     # rebuild golden-set.json from sources + annotations.json
```

## Running

Requires Node 22+, pnpm 10 and a local Postgres 16.

```
pnpm install
cp .env.example .env                  # DATABASE_URL for your dev database
pnpm migrate                          # apply migrations/ in order (sha256 ledger)
pnpm test                             # creates a throwaway database, migrates twice, runs, drops it
pnpm check                            # typecheck + test
```

Tests read `TEST_DATABASE_ADMIN_URL` (default `postgres://scopely:scopely@localhost:5432/postgres`)
and create and drop their own `scopely_test_<random>` database. Every test runs in a transaction
that is rolled back.
