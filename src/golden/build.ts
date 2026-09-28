// Builds the golden set from the verbatim OutboundOS sources plus the curated annotations.
// Pure function of its inputs: the same files always produce the same JSON, which the tests
// check against the committed fixtures/golden/golden-set.json.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REJECTION_CATEGORIES,
  type ExpectedFinding, type ExpectedOutcome, type FindingExpectation, type GoldenCase,
  type GoldenSet, type RejectionCategory, type SourceRef,
} from './types.js';

export const GOLDEN_DIR = path.resolve(import.meta.dirname, '../../fixtures/golden');
export const SOURCES_DIR = path.join(GOLDEN_DIR, 'sources/outboundos');

const REPO = 'JosephIwe/OutboundOS';
const R1 = { branch: 'claude/project-thread-21rutk', commit: '32d97c0d8cd0b42683f10012a70caf4c05c1a43e' };
const R2 = { branch: 'claude/project-thread-zi9g6y', commit: 'f2c7ab1c43f2316217a29891f6a4f48c00a5a74b' };
export const SOURCE_FILES = [
  { file: 'round1-qualification-50.csv', ...R1, path: 'research/qualification-50.csv' },
  { file: 'round1-qualification-evidence.json', ...R1, path: 'research/qualification-evidence.json' },
  { file: 'round2-prospects.csv', ...R2, path: 'research/round2/round2-prospects.csv' },
  { file: 'round2-report.md', ...R2, path: 'research/round2/round2-report.md' },
];

// ------------------------------------------------------------------ parsing

export function slug(name: string): string {
  return name.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface CsvRow { line: number; fields: Record<string, string> }

/** RFC 4180 CSV parser that records the line each row starts on. */
export function parseCsv(text: string): CsvRow[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = []; let cell = ''; let quoted = false; let line = 1; let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell); records.push({ line: rowLine, cells }); cells = []; cell = '';
      line++; rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length) { cells.push(cell); records.push({ line: rowLine, cells }); }
  const [header, ...rows] = records.filter((r) => r.cells.some((c) => c !== ''));
  if (!header) return [];
  return rows.map((r) => ({
    line: r.line,
    fields: Object.fromEntries(header.cells.map((h, idx) => [h, r.cells[idx] ?? ''])),
  }));
}

interface TableRow { line: number; cells: string[]; raw: string }

/** Rows of the markdown table that follows `heading`, up to the next heading. */
export function markdownTable(lines: string[], heading: string): TableRow[] {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const out: TableRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('## ')) break;
    if (!l.startsWith('|') || /^\|[-| ]+\|$/.test(l)) continue;
    const cells = l.slice(1, -1).split(' | ').map((c) => c.trim());
    out.push({ line: i + 1, cells, raw: l });
  }
  return out.slice(1); // drop the header row
}

// ------------------------------------------------------------------ annotations

interface AnnotationFinding {
  issue_code: string; expectation: FindingExpectation; source: string; quote: string; note?: string;
}
interface Annotation {
  findings?: AnnotationFinding[];
  rejection_category?: RejectionCategory;
  category_note?: string;
  expected_outcome?: ExpectedOutcome;
  outcome_note?: string;
  supersedes?: string;
}

// ------------------------------------------------------------------ build

interface Located { file: string; line: number; field?: string }

export function buildGoldenSet(sourcesDir = SOURCES_DIR, goldenDir = GOLDEN_DIR): GoldenSet {
  const read = (f: string) => readFileSync(path.join(sourcesDir, f), 'utf8');
  const r1Csv = parseCsv(read('round1-qualification-50.csv'));
  const r2Csv = parseCsv(read('round2-prospects.csv'));
  const reportLines = read('round2-report.md').split('\n');
  const r1JsonText = read('round1-qualification-evidence.json');
  const r1Json = JSON.parse(r1JsonText) as { i: number; name: string; domain: string }[];
  const r1JsonLines = r1JsonText.split('\n');
  const annotations = (JSON.parse(readFileSync(path.join(goldenDir, 'annotations.json'), 'utf8')) as {
    cases: Record<string, Annotation>;
  }).cases;

  const cases: GoldenCase[] = [];
  // Where each case's own text lives, so quotes are located in the right row first.
  const ownText = new Map<string, (Located & { text: string })[]>();

  // Round 1: every row of qualification-50.csv.
  for (const row of r1Csv) {
    const f = row.fields;
    const name = f.company!;
    const id = `r1-${slug(name)}`;
    const decision = f.decision!;
    const jsonEntry = r1Json.find((j) => j.i === Number(f.row));
    const jsonLine = jsonEntry ? r1JsonLines.findIndex((l) => l.trim() === `"i": ${jsonEntry.i},`) + 1 : 0;
    const sources: SourceRef[] = [{ file: 'round1-qualification-50.csv', line: row.line }];
    if (jsonLine > 0) sources.push({ file: 'round1-qualification-evidence.json', line: jsonLine });
    ownText.set(id, ['reason', 'main_problem', 'next_check'].map((field) => ({
      file: 'round1-qualification-50.csv', line: row.line, field, text: f[field] ?? '',
    })));
    const expected: ExpectedOutcome =
      decision === 'Keep' ? 'QUALIFIED' : decision === 'Reject' ? 'REJECTED' : 'NEEDS_BROWSER_CHECK';
    cases.push(baseCase(id, 1, '2026-09-23', name, f.website || null, decision, f.reason || null, f.offer || null, expected, sources));
  }

  // Round 2: ready + verify rows from the CSV, located again in the report.
  for (const row of r2Csv) {
    const f = row.fields;
    const name = f.clinic!;
    const id = `r2-${slug(name)}`;
    const reportIdx = reportLines.findIndex((l) => l.startsWith(`| ${name}`));
    const sources: SourceRef[] = [{ file: 'round2-prospects.csv', line: row.line }];
    const own: (Located & { text: string })[] = [
      { file: 'round2-prospects.csv', line: row.line, field: 'verified_issue', text: f.verified_issue ?? '' },
      { file: 'round2-prospects.csv', line: row.line, field: 'caveats', text: f.caveats ?? '' },
    ];
    if (reportIdx >= 0) {
      sources.push({ file: 'round2-report.md', line: reportIdx + 1 });
      own.unshift({ file: 'round2-report.md', line: reportIdx + 1, text: reportLines[reportIdx]! });
    }
    ownText.set(id, own);
    const expected: ExpectedOutcome = f.tier === 'READY' ? 'QUALIFIED' : 'NEEDS_BROWSER_CHECK';
    const c = baseCase(id, 2, '2026-09-24', name, f.website || null, f.tier!, f.verified_issue || null, f.offer || null, expected, sources);
    c.findings = [];
    cases.push(c);
    const ev = f.evidence_url || null;
    (c as GoldenCase & { _evidenceUrl?: string | null })._evidenceUrl = ev;
  }

  // Round 2: the unreachable sites listed in section B.
  const sectionB = markdownTable(reportLines, '## B. Needs further verification');
  const unreachable = sectionB.find((r) => r.cells[0]!.startsWith('Unreachable sites:'));
  if (!unreachable) throw new Error('round 2 unreachable row not found');
  for (const name of unreachable.cells[0]!.replace('Unreachable sites:', '').split(',').map((s) => s.trim())) {
    const id = `r2-${slug(name)}`;
    ownText.set(id, [{ file: 'round2-report.md', line: unreachable.line, text: unreachable.raw }]);
    cases.push(baseCase(id, 2, '2026-09-24', name, null, 'Unreachable', unreachable.cells[2] ?? null, null,
      'NEEDS_BROWSER_CHECK', [{ file: 'round2-report.md', line: unreachable.line }]));
  }

  // Round 2: individually named rejections in section C. The two summary rows (off-target
  // Clay results; round 1 exclusions) are not individual businesses and are skipped.
  for (const r of markdownTable(reportLines, '## C. Rejected')) {
    const name = r.cells[0]!;
    if (name.startsWith('Other off-target') || name.startsWith('Round 1 exclusions')) continue;
    const id = `r2-${slug(name)}`;
    ownText.set(id, [{ file: 'round2-report.md', line: r.line, text: r.raw }]);
    cases.push(baseCase(id, 2, '2026-09-24', name, null, 'Rejected', r.cells[1] ?? null, null,
      'REJECTED', [{ file: 'round2-report.md', line: r.line }]));
  }

  // Apply annotations.
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const id of Object.keys(annotations)) {
    if (!byId.has(id)) throw new Error(`annotation for unknown golden case ${id}`);
  }
  for (const c of cases) {
    const a = annotations[c.id] ?? {};
    const evidenceUrl = (c as GoldenCase & { _evidenceUrl?: string | null })._evidenceUrl ?? null;
    delete (c as GoldenCase & { _evidenceUrl?: string | null })._evidenceUrl;
    if (a.expected_outcome) { c.expected_outcome = a.expected_outcome; c.outcome_basis = 'curated_override'; }
    if (a.outcome_note) c.outcome_note = a.outcome_note;
    if (c.expected_outcome === 'REJECTED') {
      if (!a.rejection_category) throw new Error(`${c.id}: rejected case needs a curated rejection_category`);
      if (!REJECTION_CATEGORIES.includes(a.rejection_category)) throw new Error(`${c.id}: unknown category ${a.rejection_category}`);
      if (!c.historical_reason) throw new Error(`${c.id}: rejected case has no verbatim reason in the source`);
      c.rejection = { category: a.rejection_category, reason_verbatim: c.historical_reason };
      if (a.category_note) c.rejection.category_note = a.category_note;
    } else if (a.rejection_category) {
      throw new Error(`${c.id}: rejection_category given for a case that is not rejected`);
    }
    c.findings = (a.findings ?? []).map((af): ExpectedFinding => {
      const loc = locate(af, ownText.get(c.id) ?? [], sourcesDir, reportLines);
      const finding: ExpectedFinding = {
        issue_code: af.issue_code,
        expectation: af.expectation,
        verbatim_quote: af.quote,
        source: loc,
        url: evidenceUrl ?? (c.business.domain ? `https://${c.business.domain}/` : null),
        url_basis: evidenceUrl ? 'evidence_url' : c.business.domain ? 'business_website' : 'unknown',
      };
      if (af.note) finding.note = af.note;
      return finding;
    });
    if (a.supersedes) {
      const prior = byId.get(a.supersedes);
      if (!prior) throw new Error(`${c.id}: supersedes unknown case ${a.supersedes}`);
      c.supersedes = prior.id;
      prior.superseded_by = c.id;
    }
  }

  const current = cases.filter((c) => !c.superseded_by);
  const allFindings = cases.flatMap((c) => c.findings);
  const counts: Record<string, number> = {
    cases: cases.length,
    current_cases: current.length,
    superseded_cases: cases.length - current.length,
    round1: cases.filter((c) => c.round === 1).length,
    round2: cases.filter((c) => c.round === 2).length,
    current_qualified: current.filter((c) => c.expected_outcome === 'QUALIFIED').length,
    current_rejected: current.filter((c) => c.expected_outcome === 'REJECTED').length,
    current_needs_browser_check: current.filter((c) => c.expected_outcome === 'NEEDS_BROWSER_CHECK').length,
    findings_observed: allFindings.filter((f) => f.expectation === 'OBSERVED' && f.issue_code.startsWith('E-')).length,
    observations_booking_platform: allFindings.filter((f) => f.issue_code === 'O-BOOKING-PLATFORM').length,
    findings_needs_browser_check: allFindings.filter((f) => f.expectation === 'NEEDS_BROWSER_CHECK').length,
    findings_must_not_claim: allFindings.filter((f) => f.expectation === 'MUST_NOT_CLAIM').length,
  };

  return {
    schema_version: 1,
    generated_from: {
      repository: REPO,
      files: SOURCE_FILES.map((s) => ({ ...s, sha256: createHash('sha256').update(readFileSync(path.join(sourcesDir, s.file))).digest('hex') })),
    },
    counts,
    cases,
  };
}

function baseCase(
  id: string, round: 1 | 2, recordedOn: string, name: string, website: string | null, decision: string,
  reason: string | null, offer: string | null, expected: ExpectedOutcome, sources: SourceRef[],
): GoldenCase {
  const domain = website ? (website.replace(/^https?:\/\//, '').match(/^[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] ?? null) : null;
  return {
    id, round, recorded_on: recordedOn,
    business: {
      name, website_as_recorded: website,
      domain: domain ? domain.replace(/^www\./, '').toLowerCase() : null,
      vertical: 'aesthetics', country_code: 'GB', city: 'London',
    },
    historical_decision: decision,
    historical_reason: reason,
    historical_offer: offer,
    expected_outcome: expected,
    outcome_basis: 'historical_decision',
    findings: [],
    sources,
  };
}

/** Find a quote in the case's own rows first, then anywhere in the named file (must be unique). */
function locate(af: AnnotationFinding, own: (Located & { text: string })[], sourcesDir: string, reportLines: string[]): SourceRef {
  const inOwn = own.filter((o) => o.file === af.source && o.text.includes(af.quote));
  if (inOwn.length >= 1) {
    const o = inOwn[0]!;
    return o.field ? { file: o.file, line: o.line, field: o.field } : { file: o.file, line: o.line };
  }
  let hits: SourceRef[] = [];
  if (af.source.endsWith('.csv')) {
    for (const row of parseCsv(readFileSync(path.join(sourcesDir, af.source), 'utf8'))) {
      for (const [field, text] of Object.entries(row.fields)) {
        if (text.includes(af.quote)) hits.push({ file: af.source, line: row.line, field });
      }
    }
  } else {
    const lines = af.source === 'round2-report.md' ? reportLines
      : readFileSync(path.join(sourcesDir, af.source), 'utf8').split('\n');
    hits = lines.flatMap((l, i) => (l.includes(af.quote) ? [{ file: af.source, line: i + 1 }] : []));
  }
  if (hits.length !== 1) {
    throw new Error(`quote must occur once in ${af.source}, found ${hits.length}: ${JSON.stringify(af.quote)}`);
  }
  return hits[0]!;
}
