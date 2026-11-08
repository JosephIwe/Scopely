// Analyse a website (P3): get businesses into Scopely without a discovery provider.
//
// A person adds one entry (business name, domain, optional company number) or imports a CSV with
// those columns. Scopely creates a list (a search of kind 'list') with one run, records each entry
// through recordDiscoveredBusiness (so the workspace's duplicate handling applies: company number,
// then domain), and pre-qualifies the run under qualify.list_entry v1. From there the existing
// SELECT → ANALYSE → OPPORTUNITY → CASE FILE path takes over unchanged.
//
// What this never does: call a provider (the database refuses one on a list run), look up or
// enrich contacts, or record a fact the person did not type. Everything a list entry does not say
// (industry, location, size, revenue, structure) stays unknown. A domain is checked for shape and
// for SSRF safety here, and again by the analysis probe (DNS pinning, private ranges, redirects).
import { assertCapturableUrl } from '../build/fix/fetch.js';
import type { Db } from '../tenancy/index.js';
import { criteriaFromRow, loadQualificationFacts, prequalify, recordDiscoveredBusiness } from '../discovery/index.js';

export class ListRejected extends Error {
  readonly status = 422;
  constructor(message: string, readonly rows: RowProblem[] = []) { super(message); }
}

export interface RowProblem { row: number; field: 'name' | 'domain' | 'companyNumber' | 'row'; problem: string }

export const MAX_LIST_ENTRIES = 200;
/** Company registers a list can name. A company number is only recorded with the register it belongs to. */
export const COMPANY_REGISTERS = ['uk_companies_house'] as const;
export type CompanyRegister = typeof COMPANY_REGISTERS[number];

export interface ListEntry { name: string; domain: string | null; websiteUrl: string | null; companyNumber: string | null }
export interface ParsedEntry extends ListEntry { row: number }

export interface ListInput {
  name: string;
  source: 'manual' | 'csv_import';
  companyRegister: CompanyRegister | null;
  entries: ParsedEntry[];
  /** CSV columns that were not name, domain or company number: ignored, and said so. */
  ignoredColumns: string[];
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A domain or website address as a person typed it, reduced to the host Scopely may request.
 * Returns the bare domain (no scheme, no "www.", lower case) and the address to analyse when the
 * person gave more than a bare domain (a path, or a www. host). Refuses anything that is not a
 * public DNS name: IP literals, ports, credentials, single-label or local names.
 */
export function normaliseDomain(raw: string): { domain: string; websiteUrl: string | null } {
  const v = raw.trim();
  if (!v) throw new Error('is empty');
  if (v.length > 300 || CONTROL.test(v) || /\s/.test(v)) throw new Error('is not a web address');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new Error('is not a web address'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('must be a website (http or https)');
  if (u.username || u.password) throw new Error('must not contain a user name or password');
  if (u.port) throw new Error('must not name a port');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\[|^\d+(\.\d+){3}$/.test(host) || host.includes(':')) throw new Error('must be a domain name, not an IP address');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('is not a public domain');
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) {
    throw new Error('is not a domain name');
  }
  const domain = host.startsWith('www.') && labels.length > 2 ? host.slice(4) : host;
  const path = u.pathname === '/' ? '' : u.pathname;
  const address = `https://${host}${path}`;
  // The probe repeats this with DNS pinning at analysis time; refusing here keeps a bad row out of the list.
  assertCapturableUrl(address);
  return { domain, websiteUrl: host !== domain || path ? address : null };
}

/** A company number in its register's own format. Companies House numbers are 8 characters; a
 *  spreadsheet that dropped leading zeros is padded back (the register's convention, not a guess). */
export function normaliseCompanyNumber(raw: string, register: CompanyRegister): string {
  const v = raw.replace(/\s+/g, '').toUpperCase();
  if (register === 'uk_companies_house') {
    if (/^\d{1,8}$/.test(v)) return v.padStart(8, '0');
    if (/^[A-Z]{2}\d{6}$/.test(v)) return v;
    throw new Error('is not a Companies House number (8 digits, or 2 letters and 6 digits)');
  }
  throw new Error('has no register');
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a leading byte-order mark. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new ListRejected('The CSV has a quote that is never closed.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER: Record<string, 'name' | 'domain' | 'companyNumber'> = {
  name: 'name', 'business name': 'name', business: 'name', 'company name': 'name',
  domain: 'domain', website: 'domain', url: 'domain', 'website url': 'domain',
  'company number': 'companyNumber', 'company no': 'companyNumber', 'company_number': 'companyNumber', companynumber: 'companyNumber',
  'companies house number': 'companyNumber',
};

const headerKey = (h: string) => h.trim().toLowerCase().replace(/[_\s]+/g, ' ').replace(/\.$/, '');

/** Reads a CSV's rows into raw entries; the header row names the columns, in any order. */
export function csvEntries(text: string): { rows: { row: number; name: string; domain: string; companyNumber: string }[]; ignoredColumns: string[] } {
  const table = parseCsv(text);
  if (table.length === 0) throw new ListRejected('The CSV is empty.');
  const header = table[0]!.map(headerKey);
  const col: Partial<Record<'name' | 'domain' | 'companyNumber', number>> = {};
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const k = HEADER[h] ?? HEADER[h.replace(/ /g, '_')];
    if (k && col[k] === undefined) col[k] = i;
    else if (h) ignored.push(table[0]![i]!.trim().slice(0, 60));
  });
  if (col.name === undefined || col.domain === undefined) {
    throw new ListRejected('The CSV needs a header row with a name column and a domain column (company number is optional).');
  }
  const body = table.slice(1);
  if (body.length === 0) throw new ListRejected('The CSV has a header but no businesses.');
  if (body.length > MAX_LIST_ENTRIES) throw new ListRejected(`A list holds up to ${MAX_LIST_ENTRIES} businesses; this CSV has ${body.length}.`);
  const cell = (r: string[], i: number | undefined) => (i === undefined ? '' : (r[i] ?? '').trim());
  return {
    rows: body.map((r, i) => ({ row: i + 2, name: cell(r, col.name), domain: cell(r, col.domain), companyNumber: cell(r, col.companyNumber) })),
    ignoredColumns: ignored,
  };
}

/**
 * Validates a POST /api/lists body into a ListInput. Either `entries` (manual: one or more typed
 * entries) or `csv` (the file's text). Every row problem is reported at once and nothing is
 * imported when there is any: a list is never half-created.
 */
export function listInputFromBody(b: Record<string, unknown>): ListInput {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120 || CONTROL.test(name)) throw new ListRejected('Give the list a short name.');
  const register = b.companyRegister === undefined || b.companyRegister === null || b.companyRegister === '' ? null : String(b.companyRegister);
  if (register !== null && !(COMPANY_REGISTERS as readonly string[]).includes(register)) throw new ListRejected('Company numbers can only come from UK Companies House (uk_companies_house).');
  const hasCsv = typeof b.csv === 'string';
  const hasEntries = Array.isArray(b.entries);
  if (hasCsv === hasEntries) throw new ListRejected('Send either entries or a CSV.');

  let raw: { row: number; name: string; domain: string; companyNumber: string }[];
  let ignoredColumns: string[] = [];
  if (hasCsv) {
    ({ rows: raw, ignoredColumns } = csvEntries(b.csv as string));
  } else {
    const list = b.entries as unknown[];
    if (list.length === 0) throw new ListRejected('Add at least one business.');
    if (list.length > MAX_LIST_ENTRIES) throw new ListRejected(`A list holds up to ${MAX_LIST_ENTRIES} businesses.`);
    raw = list.map((e, i) => {
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
      return { row: i + 1, name: str(o.name), domain: str(o.domain), companyNumber: str(o.companyNumber) };
    });
  }

  const problems: RowProblem[] = [];
  const entries: ParsedEntry[] = [];
  for (const r of raw) {
    let ok = true;
    if (!r.name) { problems.push({ row: r.row, field: 'name', problem: 'Business name is missing.' }); ok = false; }
    else if (r.name.length > 200 || CONTROL.test(r.name)) { problems.push({ row: r.row, field: 'name', problem: 'Business name must be one short line.' }); ok = false; }
    let domain: string | null = null;
    let websiteUrl: string | null = null;
    if (r.domain) {
      try { ({ domain, websiteUrl } = normaliseDomain(r.domain)); } catch (err) {
        problems.push({ row: r.row, field: 'domain', problem: `Domain ${(err as Error).message.replace(/^The address /, '')}.`.replace(/\.\.$/, '.') });
        ok = false;
      }
    }
    let companyNumber: string | null = null;
    if (r.companyNumber) {
      if (!register) { problems.push({ row: r.row, field: 'companyNumber', problem: 'Say which register the company numbers are from.' }); ok = false; }
      else {
        try { companyNumber = normaliseCompanyNumber(r.companyNumber, register as CompanyRegister); } catch (err) {
          problems.push({ row: r.row, field: 'companyNumber', problem: `Company number ${(err as Error).message}.` });
          ok = false;
        }
      }
    }
    // A row with no domain is kept: it goes to review (qualify.list_entry), since it cannot be analysed.
    if (ok) entries.push({ row: r.row, name: r.name, domain, websiteUrl, companyNumber });
  }
  if (problems.length) throw new ListRejected(`${problems.length === 1 ? 'One row needs' : `${problems.length} rows need`} fixing before anything is imported.`, problems);
  return { name, source: hasCsv ? 'csv_import' : 'manual', companyRegister: register as CompanyRegister | null, entries, ignoredColumns };
}

export interface ListRowResult {
  row: number;
  businessId: string;
  /** new: created; existing: this workspace already held the business (by company number or domain);
   *  repeat: an earlier row of this list is the same business. */
  outcome: 'new' | 'existing' | 'repeat';
  matchedBy: 'new' | 'company_register' | 'domain' | 'source_reference';
  /** The row's own name differs from the name the workspace already holds; the held name is kept. */
  nameKept: string | null;
  state: string;
}

export interface ListResult {
  listId: string;
  searchRunId: string;
  source: 'manual' | 'csv_import';
  rows: ListRowResult[];
  counts: { rows: number; businesses: number; new: number; existing: number; repeats: number; qualified: number; needsReview: number; rejected: number };
  ignoredColumns: string[];
}

/** Creates the list, its run and its businesses, and pre-qualifies them. The caller owns the transaction. */
export async function createList(db: Db, input: ListInput, at = new Date()): Promise<ListResult> {
  const listId = (await db.query<{ id: string }>(`INSERT INTO scopely.searches (name, kind, description) VALUES ($1, 'list', $2) RETURNING id`,
    [input.name, input.source === 'csv_import' ? 'Imported from a CSV' : 'Added by hand'])).rows[0]!.id;
  const runId = (await db.query<{ id: string }>(`INSERT INTO scopely.search_runs (search_id, criteria) VALUES ($1, '{}') RETURNING id`, [listId])).rows[0]!.id;
  const rows: ListRowResult[] = [];
  const seen = new Map<string, number>();
  for (const e of input.entries) {
    const rec = await recordDiscoveredBusiness(db, runId, {
      source: { provider: input.source, sourceType: input.source, reference: `list:${listId}:row:${e.row}`, discoveredAt: at.toISOString() },
      name: e.name,
      ...(e.domain ? { domain: e.domain } : {}),
      ...(e.websiteUrl ? { websiteUrl: e.websiteUrl } : {}),
      ...(e.companyNumber && input.companyRegister ? { companyRegister: input.companyRegister, companyNumber: e.companyNumber } : {}),
    });
    const held = (await db.query<{ name: string }>('SELECT name FROM scopely.businesses WHERE id = $1', [rec.businessId])).rows[0]!.name;
    const outcome = !rec.newInRun ? 'repeat' : rec.matchedBy === 'new' ? 'new' : 'existing';
    if (!seen.has(rec.businessId)) seen.set(rec.businessId, e.row);
    rows.push({ row: e.row, businessId: rec.businessId, outcome, matchedBy: rec.matchedBy, nameKept: held !== e.name ? held : null, state: 'DISCOVERED' });
  }
  const q = await prequalifyList(db, runId, at);
  for (const r of rows) r.state = q.get(r.businessId) ?? r.state;
  const states = [...new Set(rows.map((r) => r.businessId))].map((id) => q.get(id));
  return {
    listId, searchRunId: runId, source: input.source, rows, ignoredColumns: input.ignoredColumns,
    counts: {
      rows: rows.length, businesses: seen.size,
      new: rows.filter((r) => r.outcome === 'new').length, existing: rows.filter((r) => r.outcome === 'existing').length,
      repeats: rows.filter((r) => r.outcome === 'repeat').length,
      qualified: states.filter((s) => s === 'QUALIFIED').length, needsReview: states.filter((s) => s === 'NEEDS_REVIEW').length,
      rejected: states.filter((s) => s === 'REJECTED').length,
    },
  };
}

/**
 * qualify.list_entry v1: the list's own (empty) criteria with the default exclusions, exactly as
 * qualify.search_criteria v1, plus an unknown website when the business has neither a domain nor a
 * website address. Returns each business's state.
 */
export async function prequalifyList(db: Db, runId: string, asOf = new Date()): Promise<Map<string, string>> {
  const run = (await db.query(`SELECT r.criteria FROM scopely.search_runs r JOIN scopely.searches s ON s.id = r.search_id
     WHERE r.id = $1 AND r.workspace_id = scopely.current_workspace_id() AND s.kind = 'list'`, [runId])).rows[0];
  if (!run) throw new Error(`list run ${runId} does not exist in this workspace`);
  const criteria = criteriaFromRow(run.criteria);
  const rule = (await db.query<{ id: string }>(`SELECT id FROM scopely.rule_versions WHERE rule_key = 'qualify.list_entry' AND version = 1`)).rows[0]!.id;
  const facts = await loadQualificationFacts(db, runId);
  const addresses = new Map((await db.query<{ id: string; business_id: string; website_url: string | null }>(
    `SELECT rb.id, rb.business_id, b.website_url FROM scopely.search_run_businesses rb JOIN scopely.businesses b ON b.id = rb.business_id
      WHERE rb.search_run_id = $1`, [runId])).rows.map((r) => [String(r.id), r]));
  const out = new Map<string, string>();
  for (const [runBusinessId, f] of facts) {
    const q = prequalify(criteria, f, asOf);
    const row = addresses.get(runBusinessId)!;
    if (!f.domain && !row.website_url) {
      q.criteria.push({ stage: 'online_presence', criterion: 'website_address', verdict: 'unknown', expected: 'a domain or website address', actual: null });
      if (q.state === 'QUALIFIED') q.state = 'NEEDS_REVIEW';
      if (!q.unknownStages.includes('online_presence')) q.unknownStages.push('online_presence');
    }
    await db.query(
      `UPDATE scopely.search_run_businesses SET state = $2, qualification = $3, failed_stage = $4, unknown_stages = $5,
         qualification_rule_version_id = $6, qualified_at = $7 WHERE id = $1`,
      [runBusinessId, q.state, JSON.stringify(q.criteria), q.failedStage, q.unknownStages, rule, asOf.toISOString()]);
    out.set(String(row.business_id), q.state);
  }
  // A business that was already in this run (a repeated row) keeps the state it has.
  for (const r of addresses.values()) if (!out.has(String(r.business_id))) out.set(String(r.business_id), 'DISCOVERED');
  return out;
}
