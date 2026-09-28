// The golden set is the benchmark Slice 3 must reproduce. These tests keep it honest: it is
// rebuilt from the verbatim sources, every quote is re-found where it claims to be, and the
// VALIDATED/HYPOTHESIS labels in the database agree with what the evidence actually shows.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGoldenSet, GOLDEN_DIR, parseCsv, SOURCES_DIR } from '../src/golden/build.js';
import type { GoldenSet } from '../src/golden/types.js';
import { useDb } from './helpers.js';

const { db } = useDb();
const committed = JSON.parse(readFileSync(path.join(GOLDEN_DIR, 'golden-set.json'), 'utf8')) as GoldenSet;

describe('golden set fixtures', () => {
  it('match a fresh build from the sources (run pnpm golden:build after editing annotations)', () => {
    expect(buildGoldenSet()).toEqual(committed);
  });

  it('record the exact source files they were built from', () => {
    for (const f of committed.generated_from.files) {
      const sha = createHash('sha256').update(readFileSync(path.join(SOURCES_DIR, f.file))).digest('hex');
      expect(sha, f.file).toBe(f.sha256);
      expect(f.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('contain positive findings, correct rejections, browser-check cases and withdrawn claims', () => {
    const c = committed.counts;
    expect(c.cases).toBe(103);
    expect(c.current_qualified).toBeGreaterThan(0);
    expect(c.current_rejected).toBeGreaterThan(0);
    expect(c.current_needs_browser_check).toBeGreaterThan(0);
    expect(c.findings_observed).toBeGreaterThan(0);
    expect(c.findings_must_not_claim).toBeGreaterThan(0);
  });

  it('have unique ids and consistent supersession links', () => {
    const ids = committed.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const byId = new Map(committed.cases.map((c) => [c.id, c]));
    for (const c of committed.cases) {
      if (c.supersedes) expect(byId.get(c.supersedes)?.superseded_by).toBe(c.id);
      if (c.superseded_by) expect(byId.get(c.superseded_by)?.supersedes).toBe(c.id);
    }
  });

  it('give every rejection a category and the verbatim reason', () => {
    for (const c of committed.cases.filter((x) => x.expected_outcome === 'REJECTED')) {
      expect(c.rejection?.category, c.id).toBeTruthy();
      expect(c.rejection?.reason_verbatim, c.id).toBe(c.historical_reason);
    }
  });

  it('only quote text that is really at the cited line or field', () => {
    const csv = new Map<string, ReturnType<typeof parseCsv>>();
    for (const c of committed.cases) {
      for (const f of c.findings) {
        const text = readFileSync(path.join(SOURCES_DIR, f.source.file), 'utf8');
        if (f.source.field) {
          if (!csv.has(f.source.file)) csv.set(f.source.file, parseCsv(text));
          const row = csv.get(f.source.file)!.find((r) => r.line === f.source.line);
          expect(row?.fields[f.source.field], `${c.id} ${f.issue_code}`).toContain(f.verbatim_quote);
        } else {
          expect(text.split('\n')[f.source.line - 1], `${c.id} ${f.issue_code}`).toContain(f.verbatim_quote);
        }
      }
    }
  });

  it('never invent a URL: evidence URLs come from the source, otherwise the recorded website', () => {
    for (const c of committed.cases) {
      for (const f of c.findings) {
        if (f.url_basis === 'business_website') expect(f.url).toBe(`https://${c.business.domain}/`);
        if (f.url_basis === 'unknown') expect(f.url).toBeNull();
      }
    }
  });
});

describe('golden set agrees with the reference data', () => {
  it('uses only issue codes that exist', async () => {
    const codes = new Set((await db().query('SELECT code FROM issue_codes')).rows.map((r) => r.code as string));
    for (const c of committed.cases) for (const f of c.findings) expect(codes.has(f.issue_code), `${c.id} ${f.issue_code}`).toBe(true);
  });

  it('cites only golden cases that exist in every validation basis', async () => {
    const ids = new Set(committed.cases.map((c) => c.id));
    const rows = (await db().query(`SELECT validation_basis FROM issue_codes WHERE validation_basis IS NOT NULL
      UNION ALL SELECT validation_basis FROM rule_versions WHERE validation_basis IS NOT NULL
      UNION ALL SELECT validation_basis FROM niche_playbooks WHERE validation_basis IS NOT NULL`)).rows;
    const cited = rows.flatMap((r) => (r.validation_basis as string).match(/\br[12]-[a-z0-9-]+[a-z0-9]/g) ?? []);
    expect(cited.length).toBeGreaterThan(10);
    for (const id of cited) expect(ids.has(id), id).toBe(true);
  });

  it('labels an issue code VALIDATED exactly when the golden set holds an OBSERVED finding for it', async () => {
    const observed = new Set(committed.cases.flatMap((c) => c.findings.filter((f) => f.expectation === 'OBSERVED').map((f) => f.issue_code)));
    const rows = (await db().query(`SELECT code, validation_status FROM issue_codes`)).rows as { code: string; validation_status: string }[];
    for (const r of rows) {
      expect(r.validation_status, r.code).toBe(observed.has(r.code) ? 'VALIDATED' : 'HYPOTHESIS');
    }
  });
});
