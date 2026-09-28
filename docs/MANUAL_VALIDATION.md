# Manual validation runbook (20–30 prospects)

The goal is commercial signal, not audit volume: do prospects with evidence-backed problems reply,
take calls and pay? Every step below writes to the same tables later automation will use, so the
results stay comparable.

## Before the first email

These are operator actions outside the code:

1. SPF, DKIM and DMARC on josephiwe.com for `hello@josephiwe.com`.
2. A privacy notice on josephiwe.com (see open decision B4 in `DECISIONS.md`).
3. A local Postgres 16 and `pnpm migrate` against `DATABASE_URL`.

## Per prospect

Each command reads one JSON object from a file or stdin (`-`), runs in its own transaction and
prints ids only. The database refuses anything that breaks the Truth Rule, and the whole command
rolls back.

| Step | Command | Notes |
|---|---|---|
| 1. Add the business | `pnpm record prospect` | `marketId`, `name`, `domain`, `companyType`, `companyStatus`, `source` |
| 2. Qualify or reject | `pnpm record qualify` / `pnpm record reject` | A rejection names its category, stage and rule key |
| 3. Capture the page | `pnpm record snapshot` | `fetchMethod: "manual"`; store the HTML/screenshot yourself and put the key in `htmlRef` / `screenshotRef` |
| 4. Record what you saw | `pnpm record finding` | `state` is OBSERVED, INFERRED or NOT_OBSERVABLE. Only a gap or defect you saw carries `evidence` with a verbatim quote |
| 5. Record the opportunity | `pnpm record opportunity` | `evidenceIds`, `catalogKey` (or `null` + `unmappedReason`), price in the catalog band, `notObservableNotes` |
| 6. Add the contact | `pnpm record contact` | `outreachBasis` must be `corporate_subscriber` (UK: active Ltd/LLP) or `consent` |
| 7. Draft the message | `pnpm record message` | Cite only this opportunity's evidence |
| 8. Approve it | `pnpm record approve-message` | Refused for an unlawful or suppressed recipient |
| 9. Re-check HIGH evidence | `pnpm record snapshot`, `finding`, then `pnpm record recheck` | A fresh snapshot, the same check re-run, and `confirmed`, `changed` or `gone` |
| 10. Send it by hand from Gmail | `pnpm record message-sent` | Refused if HIGH evidence has no confirmed re-check, or any evidence is changed or gone |
| 11. Log what happens | `pnpm record outcome` | `pitched` (with `messageId`), `replied` (+ `replyClass`), `call`, `won` (+ `amount`), `lost`, `delivered` |
| 12. Log time and money | `pnpm record cost` | `operator_time` with `minutes`; an unknown amount stays NULL |

Example, step 1:

```json
{ "marketId": "2", "name": "Example Plumbing Ltd", "domain": "example-plumbing.test",
  "vertical": "home_services", "subvertical": "plumbing", "countryCode": "GB", "city": "Reading",
  "companyNumber": "00000000", "companyRegister": "uk_companies_house",
  "companyType": "ltd", "companyStatus": "active", "source": { "kind": "csv_import", "ref": "list.csv:2" } }
```

## Reading the results

- `pnpm record ledger`: one row per opportunity with niche, geography, evidence types, service,
  price, pitch message, latest reply, calls, result, deal value, delivery, costs and verification.
- `pnpm record funnel`: per market, prospects processed, qualified, opportunities, pitched, messages
  sent, replies, calls, wins, revenue, delivery and analysis cost, gross profit and revenue per 100
  prospects.

Unknown values are NULL. `time_saved_minutes` stays NULL until a manual baseline is measured.
Record operator minutes on every prospect: they are the baseline.
