// The Build Workspace server: a thin HTTP layer over src/build/site/service.ts, plus the preview
// endpoints. No framework and no new dependency.
//
// Authentication is open decision B10, so this server does not pretend to have it: it acts in the
// one workspace it was started with (SCOPELY_WORKSPACE_ID, like the CLI) and binds to localhost by
// default. Every request runs in its own transaction inside that workspace. Preview links are the
// exception: each carries its own signed workspace, project and version, and is checked against
// the database in that workspace before any byte is served.
//
// Logs carry ids and status codes only: never site content, contact details or credentials.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getCaseFile, opportunityBuildInfo, stageOf } from '../api/case-file.js';
import { getSearch, listOpportunities, listSearches } from '../api/queries.js';
import { OutcomeRejected, recordManualOutcome } from '../sell/outcomes.js';
import {
  ProspectRejected, checkCaseFact, recordCaseFact, recordCaseRecheck, recordCompanyRegister, saveCaseContact, suppressFromCaseFile, useFactAsEmail,
} from '../sell/prospect.js';
import { ProspectLookupRefused, runProspectLookup } from '../prospects/index.js';
import {
  ARTIFACT_HEADERS, type EditInterpreter, EditRejected, SiteError, approveVersion, generateSite, getBuildSetup, getSiteWorkspace,
  listProspectLinks, loadPreviewArtifact, openWebsiteProject, previewLink, renderDraft, requestAiEdit, restoreVersion, revokeProspectLink, saveEdits, showVersion, uploadImage,
  verifyPreview,
} from '../build/site/index.js';
import { FONT_DIR } from '../build/site/fonts.js';
import {
  type PageFetcher, SafePageFetcher, captureFixPage, confirmFix, generateFix, getFixWorkspace, openFixProject, proposeCorrection, readFixPage, showFixVersion,
} from '../build/fix/index.js';
import type { ObjectStore } from '../storage/index.js';
import type { SecretResolver } from '../build/agents.js';
import { getRunDiscovery } from '../api/discovery.js';
import { getRunBusinessAnalysis } from '../api/analysis.js';
import { AnalysisRefused, DemoAwareProbe, type Probe, analyzeRunBusiness } from '../analysis/index.js';
import { createSearch, selectForAnalysis, startSearchRun } from '../discovery/index.js';
import { DiscoveryProviderRegistry, DiscoveryRefused, ProspectProviderRegistry, runProviderDiscovery } from '../providers/index.js';
import { FindRejected, searchInputFromBody, selectionFromBody, selectionRefusal } from './discovery-api.js';
import { withWorkspace } from '../tenancy/index.js';

export interface ServerConfig {
  pool: pg.Pool;
  store: ObjectStore;
  workspaceId: string;
  /** Platform secret for preview links. Never a model credential; never sent to a browser. */
  signingKey: string;
  editLinkTtlSeconds: number;
  showLinkTtlSeconds: number;
  interpreter?: EditInterpreter;
  /** How the Fix Builder captures a page (F3). Defaults to the SSRF-safe live fetcher. */
  fetcher?: PageFetcher;
  log?: (line: string) => void;
  /** Slice 10: business discovery providers and the server-side secret resolver for live ones. */
  discovery?: { providers: DiscoveryProviderRegistry; secrets?: SecretResolver };
  /** Slice 11: how an analysis requests a business's pages. Defaults to the SSRF-safe probe (demo hosts from fixtures). */
  probe?: Probe;
  /** Slice 12: prospect intelligence providers, and the same server-side secret resolver for live ones. */
  prospects?: { providers: ProspectProviderRegistry; secrets?: SecretResolver };
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
// U2: the root is the public landing page (noindex until launch, L3); the product lives under /app.
const STATIC: Record<string, [string, string]> = {
  '/': ['landing.html', 'text/html; charset=utf-8'],
  '/landing.js': ['landing.js', 'text/javascript; charset=utf-8'],
  '/landing.css': ['landing.css', 'text/css; charset=utf-8'],
  '/app': ['index.html', 'text/html; charset=utf-8'],
  '/app/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
  '/shell.js': ['shell.js', 'text/javascript; charset=utf-8'],
  '/case-file.js': ['case-file.js', 'text/javascript; charset=utf-8'],
  '/map-slot.js': ['map-slot.js', 'text/javascript; charset=utf-8'],
  '/shell.css': ['shell.css', 'text/css; charset=utf-8'],
  '/find.js': ['find.js', 'text/javascript; charset=utf-8'],
  '/find.css': ['find.css', 'text/css; charset=utf-8'],
};

/** The workspace's own typefaces (the same files the site template embeds). */
const FONTS: Record<string, string> = {
  '/fonts/geist.woff2': 'geist-latin-wght.woff2',
  '/fonts/geist-mono-400.woff2': 'geist-mono-latin-400.woff2',
  '/fonts/geist-mono-500.woff2': 'geist-mono-latin-500.woff2',
  '/fonts/instrument-serif.woff2': 'instrument-serif-latin-400.woff2',
  '/fonts/instrument-serif-italic.woff2': 'instrument-serif-latin-400-italic.woff2',
  // The landing page's text face (IBM Plex Sans) and its evidence face (IBM Plex Mono).
  '/fonts/plex-sans.woff2': 'ibm-plex-sans-latin-wght.woff2',
  '/fonts/plex-mono-400.woff2': 'ibm-plex-mono-latin-400.woff2',
  '/fonts/plex-mono-500.woff2': 'ibm-plex-mono-latin-500.woff2',
  '/fonts/newsreader-400.woff2': 'newsreader-latin-400.woff2',
  '/fonts/newsreader-500.woff2': 'newsreader-latin-500.woff2',
};

// font-src allows data: because the live preview is a srcdoc frame, which inherits this policy, and
// the site embeds its typefaces as data: URLs.
const APP_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string>) {
  res.writeHead(status, headers);
  res.end(body);
}
const json = (res: ServerResponse, status: number, v: unknown) =>
  send(res, status, JSON.stringify(v), { ...APP_HEADERS, 'content-type': 'application/json; charset=utf-8' });

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'That is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  try {
    const v = JSON.parse((await body(req, 256 * 1024)).toString('utf8') || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'That request was not valid JSON.');
  }
}

const id = (v: string | undefined) => {
  if (!v || !/^\d{1,18}$/.test(v)) throw new HttpError(404, 'Not found.');
  return v;
};

/** What the versions list calls who made a version. */
const madeBy = (generator: string) => generator.startsWith('agent:') ? 'Scopely' : generator.startsWith('editor:') ? 'You' : 'Operator';

/** What kind of change made a version: the first build, an AI edit, a restore or undo, or a person's saved edits. */
const versionKind = (v: { versionNo: number; generator: string; summary: string }) => v.versionNo === 1 && v.generator.startsWith('agent:') ? 'build'
  : v.generator.startsWith('agent:') ? 'ai' : /^(Restored|Undid) version/.test(v.summary) ? 'restore' : 'manual';

/** A sandboxed frame sends the origin "null", which is never this server. */
function sameHost(origin: string, host: string | undefined): boolean {
  try { return Boolean(host) && new URL(origin).host === host; } catch { return false; }
}

// Postgres codes for a table, column or function this code needs that the database does not have
// (undefined_table, undefined_column, undefined_function): the database is older than the code.
const SCHEMA_BEHIND = new Set(['42P01', '42703', '42883']);
export const SCHEMA_BEHIND_MESSAGE = 'The database is missing a table or column this version of Scopely needs, so a migration has probably not been applied. '
  + 'Run pnpm migrate, then restart the server. Nothing was changed.';

export function createHandler(cfg: ServerConfig) {
  const log = cfg.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const fetcher = cfg.fetcher ?? new SafePageFetcher();
  const probe = cfg.probe ?? new DemoAwareProbe();

  /** Runs `fn` in one transaction acting in the server's workspace. */
  async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await cfg.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL search_path = scopely, public');
      const out = await withWorkspace(db, cfg.workspaceId, () => fn(db));
      await db.query('COMMIT');
      return out;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      db.release();
    }
  }

  /** The workspace screen, with nothing a person would have to understand: no storage keys, hashes or ids of internals. */
  async function workspaceView(db: pg.PoolClient, projectId: string, selected: string | null) {
    const w = await getSiteWorkspace(db, cfg.store, projectId, { selected });
    const p = w.project;
    return {
      project: { projectId: p.projectId, title: p.title },
      opportunity: { opportunityId: p.opportunity.opportunityId, business: p.opportunity.business.name, service: p.opportunity.service.name,
        price: p.opportunity.service.price, currency: p.opportunity.service.currency },
      versions: [...p.versions].reverse().map((v) => ({
        buildId: v.buildId, versionNo: v.versionNo, status: v.status, summary: v.summary, madeBy: madeBy(v.generator), kind: versionKind(v), createdAt: v.createdAt,
        approvedBy: v.approval.approvedBy, approvedAt: v.approval.approvedAt, shownAt: v.shown.shownAt,
      })),
      current: w.current && {
        buildId: w.current.buildId, versionNo: w.current.versionNo, status: w.current.status, document: w.current.document,
        readiness: w.current.readiness, html: w.current.html, approveBlocker: w.current.approveBlocker, showBlocker: w.current.showBlocker,
        upgraded: w.current.upgraded,
      },
      template: w.template,
      images: w.images,
      links: (await listProspectLinks(db, projectId, { signingKey: cfg.signingKey })).map((l) => ({
        linkId: l.linkId, versionNo: l.versionNo, state: l.state, createdAt: l.createdAt, expiresAt: l.expiresAt,
        revokedAt: l.revokedAt, revokedBy: l.revokedBy, url: l.token ? `/s/${l.token}` : null,
      })),
    };
  }

  async function api(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL) {
    const m = req.method;
    const [a, b, c, d, e] = parts;
    // GET /api/workspace: who the app is acting for. Authentication is B10, so it says so.
    if (m === 'GET' && a === 'workspace' && !b) {
      return json(res, 200, await tx(async (db) => {
        const w = (await db.query('SELECT name FROM scopely.workspaces WHERE id = scopely.current_workspace_id()')).rows[0];
        if (!w) throw new HttpError(404, 'Not found.');
        return { name: w.name, authenticated: false };
      }));
    }
    // GET /api/opportunities
    if (m === 'GET' && a === 'opportunities' && !b) {
      return json(res, 200, await tx(async (db) => {
        const feed = await listOpportunities(db, { limit: 200 });
        const ids = feed.map((f) => f.opportunityId);
        // One client runs one query at a time.
        const issues = await db.query(`SELECT DISTINCT ON (oe.opportunity_id) oe.opportunity_id, e.plain_issue, e.quote, e.url, e.claim_state, e.observed_at,
                             o.visible_text FROM scopely.opportunity_evidence oe
                      JOIN scopely.evidence e ON e.id = oe.evidence_id JOIN scopely.observations o ON o.id = e.observation_id
                     WHERE oe.opportunity_id = ANY ($1) AND e.workspace_id = scopely.current_workspace_id()
                     ORDER BY oe.opportunity_id, CASE e.confidence WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, e.id`, [ids]);
        const reviews = await db.query(`SELECT id, rating, review_count FROM scopely.businesses WHERE id = ANY ($1) AND workspace_id = scopely.current_workspace_id()`,
          [feed.map((f) => f.business.businessId)]);
        const info = await opportunityBuildInfo(db, ids);
        const captures = await db.query(`SELECT DISTINCT p.opportunity_id FROM scopely.fix_captures c JOIN scopely.build_projects p ON p.id = c.project_id
                      WHERE p.opportunity_id = ANY ($1) AND c.workspace_id = scopely.current_workspace_id()`, [ids]);
        const captured = new Set(captures.rows.map((r) => String(r.opportunity_id)));
        const issue = new Map(issues.rows.map((r) => [String(r.opportunity_id), r]));
        const rev = new Map(reviews.rows.map((r) => [String(r.id), r]));
        return feed.map((f) => {
          const i = issue.get(f.opportunityId);
          const r = rev.get(f.business.businessId);
          const bi = info.get(f.opportunityId) ?? { buildable: false, projectId: null, fixable: false, fixProjectId: null };
          return {
            opportunityId: f.opportunityId, business: f.business.name, domain: f.business.domain, path: f.path, kind: f.kind,
            service: f.service.name, price: f.service.price, currency: f.service.currency, evidenceCount: f.evidence.count,
            topConfidence: f.evidence.topConfidence, issue: i?.plain_issue ?? null, buildState: f.buildState,
            buildable: bi.buildable, projectId: bi.projectId, fixable: bi.fixable, fixProjectId: bi.fixProjectId,
            // Slice 8: what the feed and its filters show. All stored values.
            stage: stageOf(f), captured: captured.has(f.opportunityId), sellState: f.sellState, deliveryState: f.deliveryState,
            vertical: f.business.vertical, city: f.business.city, websiteStatus: f.business.websiteStatus,
            rating: r?.rating === null || r?.rating === undefined ? null : String(r.rating), reviewCount: r?.review_count ?? null,
            observed: i ? { text: i.visible_text ?? null, quote: i.quote, url: i.url, claimState: i.claim_state, observedAt: new Date(i.observed_at).toISOString() } : null,
          };
        });
      }));
    }
    // GET /api/opportunities/:id: the Case File
    if (m === 'GET' && a === 'opportunities' && !c) {
      const oid = id(b);
      return json(res, 200, await tx(async (db) => {
        const cf = await getCaseFile(db, oid);
        if (!cf) throw new HttpError(404, 'Not found.');
        // The prospect link the seller can cite, when one is active. Never an edit link.
        let showLink: { url: string; versionNo: number; expiresAt: string } | null = null;
        if (cf.build.projectId) {
          const l = (await listProspectLinks(db, cf.build.projectId, { signingKey: cfg.signingKey })).find((x) => x.state === 'ACTIVE' && x.token);
          if (l) showLink = { url: `/s/${l.token}`, versionNo: l.versionNo, expiresAt: l.expiresAt };
        }
        let fix = null;
        if (cf.build.builder === 'fix' && cf.build.projectId) {
          const w = await getFixWorkspace(db, cfg.store, cf.build.projectId);
          fix = { steps: w.steps, captured: w.capture ? { capturedAt: w.capture.capturedAt, finalUrl: w.capture.finalUrl } : null,
            correction: w.correction ? { reads: w.correction.reads, confirmedAt: w.correction.confirmedAt } : null };
        }
        // Slice 12: the prospect providers this server offers. Whether a live one is connected is all the screen learns.
        const conns = new Set((await db.query<{ provider: string }>(`SELECT DISTINCT provider FROM scopely.provider_connections
          WHERE workspace_id = scopely.current_workspace_id() AND state = 'ACTIVE' AND 'prospects' = ANY (scopes) AND credential_ref IS NOT NULL
            AND mode = 'CUSTOMER_KEY'`)).rows.map((r) => r.provider));
        const prospectProviders = (cfg.prospects?.providers.list() ?? []).map((p) => ({ key: p.provider, label: p.label, transport: p.transport, kinds: p.kinds,
          ready: p.transport === 'recorded' || (conns.has(p.provider) && Boolean(cfg.prospects?.secrets)) }));
        return { ...cf, build: { ...cf.build, showLink, fix }, buyer: { ...cf.buyer, providers: prospectProviders } };
      }));
    }
    // POST /api/opportunities/:id/outcomes: a manual SELL record (U4). Nothing is sent.
    if (m === 'POST' && a === 'opportunities' && c === 'outcomes' && !d) {
      const oid = id(b);
      const bd = await jsonBody(req);
      const outcomeId = await tx((db) => recordManualOutcome(db, oid, {
        kind: String(bd.kind ?? ''), occurredOn: String(bd.occurredOn ?? ''), recordedBy: String(bd.recordedBy ?? ''),
        channel: bd.channel ?? null, replyClass: bd.replyClass ?? null, amount: bd.amount ?? null, currency: bd.currency ?? null,
        notes: bd.notes ?? null, correctsOutcomeId: bd.correctsOutcomeId ?? null,
      }));
      log(`outcome ${outcomeId} opportunity ${oid} ${String(bd.kind)}`);
      return json(res, 200, { outcomeId });
    }
    // Slice 9, Prospect Readiness: the Case File's writers. Each acts on this opportunity only.
    // POST /api/opportunities/:id/evidence/:eid/recheck: a person's re-check of a cited finding.
    if (m === 'POST' && a === 'opportunities' && c === 'evidence' && d && e === 'recheck' && !parts[5]) {
      const oid = id(b);
      const eid = id(d);
      const bd = await jsonBody(req);
      const out = await tx((db) => recordCaseRecheck(db, oid, eid, { result: String(bd.result ?? ''), recordedBy: String(bd.recordedBy ?? ''), notes: bd.notes ?? null }));
      log(`recheck ${out.recheckId} evidence ${eid} opportunity ${oid} ${String(bd.result)}`);
      return json(res, 200, out);
    }
    // POST /api/opportunities/:id/contacts, and /contacts/:cid to correct one.
    if (m === 'POST' && a === 'opportunities' && c === 'contacts' && !e) {
      const oid = id(b);
      const cid = d === undefined ? undefined : id(d);
      const bd = await jsonBody(req);
      const contactId = await tx((db) => saveCaseContact(db, oid, {
        fullName: bd.fullName ?? null, role: bd.role ?? null, isDecisionMaker: bd.isDecisionMaker === true, email: bd.email ?? null,
        emailKind: bd.emailKind ?? null, source: bd.source ?? null, sourceUrl: bd.sourceUrl ?? null, label: bd.label ?? null, outreachBasis: bd.outreachBasis ?? null,
        relationship: bd.relationship ?? null, relationshipBasis: bd.relationshipBasis ?? null, decisionMakerBasis: bd.decisionMakerBasis ?? null,
        verificationBasis: bd.verificationBasis ?? null, recordedBy: bd.recordedBy ?? null,
      }, cid));
      log(`contact ${contactId} opportunity ${oid} ${cid ? 'updated' : 'added'}`);
      return json(res, 200, { contactId });
    }
    // Slice 12, Prospect Intelligence.
    // POST /api/opportunities/:id/prospects/lookup: ask a prospect provider who works at the business.
    if (m === 'POST' && a === 'opportunities' && c === 'prospects' && d === 'lookup' && !e) {
      const oid = id(b);
      const bd = await jsonBody(req);
      const providers = cfg.prospects?.providers ?? new ProspectProviderRegistry();
      const out = await tx((db) => runProspectLookup(db, { providers, secrets: cfg.prospects?.secrets }, oid, String(bd.provider ?? '')));
      log(`prospect lookup ${out.operationId} opportunity ${oid} ${out.provider} ${out.transport} returned=${out.returned} added=${out.added}${out.error ? ` ${out.error.code}` : ''}`);
      return json(res, 200, out);
    }
    // POST /api/opportunities/:id/facts: a channel the seller found; /facts/:fid: the seller's check of one on file.
    if (m === 'POST' && a === 'opportunities' && c === 'facts' && !e) {
      const oid = id(b);
      const bd = await jsonBody(req);
      if (d === undefined) {
        const factId = await tx((db) => recordCaseFact(db, oid, { contactId: bd.contactId ?? null, kind: String(bd.kind ?? ''), value: String(bd.value ?? ''),
          sourceUrl: bd.sourceUrl ?? null, label: bd.label ?? null, basis: bd.basis ?? null, recordedBy: String(bd.recordedBy ?? '') }));
        log(`fact ${factId} opportunity ${oid} added`);
        return json(res, 200, { factId });
      }
      const fid = id(d);
      await tx((db) => checkCaseFact(db, oid, fid, { label: String(bd.label ?? ''), basis: bd.basis ?? null, recordedBy: String(bd.recordedBy ?? '') }));
      log(`fact ${fid} opportunity ${oid} checked ${String(bd.label)}`);
      return json(res, 200, { ok: true });
    }
    // POST /api/opportunities/:id/contacts/:cid/email: make an email fact the contact's email of record.
    if (m === 'POST' && a === 'opportunities' && c === 'contacts' && d && e === 'email' && !parts[5]) {
      const oid = id(b);
      const cid = id(d);
      const bd = await jsonBody(req);
      await tx((db) => useFactAsEmail(db, oid, cid, String(bd.factId ?? '')));
      log(`contact ${cid} opportunity ${oid} email from fact`);
      return json(res, 200, { ok: true });
    }
    // POST /api/opportunities/:id/company: the company register facts the seller looked up.
    if (m === 'POST' && a === 'opportunities' && c === 'company' && !d) {
      const oid = id(b);
      const bd = await jsonBody(req);
      await tx((db) => recordCompanyRegister(db, oid, { register: bd.register ?? null, number: bd.number ?? null, type: bd.type ?? null, status: bd.status ?? null }));
      log(`company register opportunity ${oid}`);
      return json(res, 200, { ok: true });
    }
    // POST /api/opportunities/:id/suppressions: stop contacting an address, the domain or the business.
    if (m === 'POST' && a === 'opportunities' && c === 'suppressions' && !d) {
      const oid = id(b);
      const bd = await jsonBody(req);
      const suppressionId = await tx((db) => suppressFromCaseFile(db, oid, { target: String(bd.target ?? ''), contactId: bd.contactId ?? null, reason: String(bd.reason ?? '') }));
      log(`suppression ${suppressionId} opportunity ${oid} ${String(bd.target)}`);
      return json(res, 200, { suppressionId });
    }
    // POST /api/opportunities/:id/website
    if (m === 'POST' && a === 'opportunities' && c === 'website' && !d) {
      const oid = id(b);
      return json(res, 200, { projectId: await tx((db) => openWebsiteProject(db, oid)) });
    }
    // POST /api/opportunities/:id/fix
    if (m === 'POST' && a === 'opportunities' && c === 'fix' && !d) {
      const oid = id(b);
      return json(res, 200, { projectId: await tx((db) => openFixProject(db, oid)) });
    }
    if (a === 'fix') return fixApi(req, res, parts);
    if (a === 'discovery' || a === 'searches' || a === 'runs') return findApi(req, res, parts);
    if (a !== 'projects') throw new HttpError(404, 'Not found.');
    const pid = id(b);
    if (m === 'GET' && c === 'setup' && !d) return json(res, 200, await tx((db) => getBuildSetup(db, pid)));
    if (m === 'GET' && c === 'workspace' && !d) {
      const sel = url.searchParams.get('selected');
      return json(res, 200, await tx((db) => workspaceView(db, pid, sel && /^[a-z]{2,20}$/.test(sel) ? sel : null)));
    }
    if (m === 'POST' && c === 'generate' && !d) {
      const bd = await jsonBody(req);
      const out = await tx((db) => generateSite(db, { store: cfg.store, interpreter: cfg.interpreter }, pid, { templateKey: String(bd.templateKey ?? '') }));
      log(`run ${out.runId} project ${pid} ${out.status}${out.errorCode ? ` ${out.errorCode}` : ''}`);
      return json(res, 200, out);
    }
    if (m === 'POST' && c === 'render' && !d) {
      const bd = await jsonBody(req);
      const sel = typeof bd.selected === 'string' && /^[a-z]{2,20}$/.test(bd.selected) ? bd.selected : null;
      return json(res, 200, await tx((db) => renderDraft(db, cfg.store, pid, { baseBuildId: String(bd.baseBuildId ?? ''), operations: bd.operations, selected: sel })));
    }
    if (m === 'POST' && c === 'save' && !d) {
      const bd = await jsonBody(req);
      const out = await tx((db) => saveEdits(db, cfg.store, pid, { baseBuildId: String(bd.baseBuildId ?? ''), operations: bd.operations }));
      log(`version ${out.buildId} project ${pid} saved`);
      return json(res, 200, out);
    }
    if (m === 'POST' && c === 'ai-edit' && !d) {
      const bd = await jsonBody(req);
      const out = await tx((db) => requestAiEdit(db, { store: cfg.store, interpreter: cfg.interpreter }, pid,
        { baseBuildId: String(bd.baseBuildId ?? ''), request: String(bd.request ?? '') }));
      log(`run ${out.runId} project ${pid} ${out.status}${out.errorCode ? ` ${out.errorCode}` : ''}`);
      return json(res, 200, out);
    }
    if (m === 'POST' && c === 'restore' && !d) {
      const bd = await jsonBody(req);
      const out = await tx((db) => restoreVersion(db, cfg.store, pid, { baseBuildId: String(bd.baseBuildId ?? ''), fromBuildId: String(bd.fromBuildId ?? ''), undo: bd.undo === true }));
      log(`version ${out.buildId} project ${pid} ${bd.undo === true ? 'undo' : 'restored'}`);
      return json(res, 200, out);
    }
    if (m === 'POST' && c === 'images' && !d) {
      const bytes = await body(req, 5 * 1024 * 1024 + 1);
      const description = decodeURIComponent(String(req.headers['x-description'] ?? '')).slice(0, 400);
      return json(res, 200, await tx((db) => uploadImage(db, cfg.store, pid, { bytes, description, recordedBy: 'seller' })));
    }
    if (c === 'links' && m === 'POST' && e === 'revoke') {
      const lid = id(d);
      const bd = await jsonBody(req);
      await tx((db) => revokeProspectLink(db, pid, lid, { revokedBy: String(bd.revokedBy ?? '') }));
      log(`link ${lid} revoked`);
      return json(res, 200, { ok: true });
    }
    if (c === 'versions' && m === 'POST') {
      const bid = id(d);
      if (e === 'approve') {
        const bd = await jsonBody(req);
        await tx((db) => approveVersion(db, pid, bid, { approvedBy: String(bd.approvedBy ?? '') }));
        log(`version ${bid} approved`);
        return json(res, 200, { ok: true });
      }
      if (e === 'show') {
        const link = await tx(async (db) => {
          await showVersion(db, cfg.store, pid, bid);
          return previewLink(db, pid, bid, { kind: 'show', signingKey: cfg.signingKey, ttlSeconds: cfg.showLinkTtlSeconds });
        });
        log(`version ${bid} shown, link ${link.linkId}`);
        return json(res, 200, { url: `/s/${link.token}`, expiresAt: link.expiresAt });
      }
      if (e === 'link') {
        const bd = await jsonBody(req);
        const kind = bd.kind === 'show' ? 'show' : 'edit';
        const link = await tx((db) => previewLink(db, pid, bid, { kind, signingKey: cfg.signingKey,
          ttlSeconds: kind === 'show' ? cfg.showLinkTtlSeconds : cfg.editLinkTtlSeconds }));
        if (link.linkId) log(`link ${link.linkId} created for version ${bid}`);
        return json(res, 200, { url: kind === 'show' ? `/s/${link.token}` : `/p/${link.token}`, expiresAt: link.expiresAt });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  /** The Fix Builder: /api/fix/:projectId/... */
  async function fixApi(req: IncomingMessage, res: ServerResponse, parts: string[]) {
    const m = req.method;
    const [, b, c, d, e] = parts;
    const pid = id(b);
    if (m === 'GET' && !c) {
      return json(res, 200, await tx(async (db) => {
        const w = await getFixWorkspace(db, cfg.store, pid);
        const links = (await listProspectLinks(db, pid, { signingKey: cfg.signingKey })).map((l) => ({
          linkId: l.linkId, versionNo: l.versionNo, state: l.state, createdAt: l.createdAt, expiresAt: l.expiresAt,
          revokedAt: l.revokedAt, revokedBy: l.revokedBy, url: l.token ? `/s/${l.token}` : null,
        }));
        // The document's storage keys and hashes stay on the server.
        const cur = w.current && { ...w.current, document: { ...w.current.document, capture: undefined, after: undefined } };
        return { ...w, current: cur, links };
      }));
    }
    if (m !== 'POST') throw new HttpError(404, 'Not found.');
    if (c === 'capture' && !d) {
      const bd = await jsonBody(req);
      const out = await tx((db) => captureFixPage(db, { store: cfg.store, fetcher }, pid, { evidenceId: String(bd.evidenceId ?? ''), capturedBy: 'Scopely' }));
      log(`capture ${out.captureId} project ${pid}`);
      return json(res, 200, out);
    }
    if (c === 'corrections' && !d) {
      const bd = await jsonBody(req);
      const out = await tx((db) => proposeCorrection(db, pid, { evidenceId: String(bd.evidenceId ?? ''), channel: String(bd.channel ?? ''),
        value: String(bd.value ?? ''), proposedBy: 'seller' }));
      log(`correction ${out.correctionId} project ${pid}`);
      return json(res, 200, out);
    }
    if (c === 'generate' && !d) {
      const out = await tx((db) => generateFix(db, { store: cfg.store }, pid));
      log(`run ${out.runId} project ${pid} ${out.status}${out.errorCode ? ` ${out.errorCode}` : ''}`);
      return json(res, 200, out);
    }
    if (c === 'versions') {
      const bid = id(d);
      if (e === 'confirm') {
        const bd = await jsonBody(req);
        await tx((db) => confirmFix(db, pid, bid, { confirmedBy: String(bd.confirmedBy ?? ''), confirmed: bd.confirmed === true }));
        log(`version ${bid} confirmed and approved`);
        return json(res, 200, { ok: true });
      }
      if (e === 'show') {
        const link = await tx(async (db) => {
          await showFixVersion(db, pid, bid);
          return previewLink(db, pid, bid, { kind: 'show', signingKey: cfg.signingKey, ttlSeconds: cfg.showLinkTtlSeconds });
        });
        log(`version ${bid} shown, link ${link.linkId}`);
        return json(res, 200, { url: `/s/${link.token}`, expiresAt: link.expiresAt });
      }
      if (e === 'link') {
        const bd = await jsonBody(req);
        if (bd.kind === 'show') {
          const link = await tx((db) => previewLink(db, pid, bid, { kind: 'show', signingKey: cfg.signingKey, ttlSeconds: cfg.showLinkTtlSeconds }));
          if (link.linkId) log(`link ${link.linkId} created for version ${bid}`);
          return json(res, 200, { url: `/s/${link.token}`, expiresAt: link.expiresAt });
        }
        const link = await tx((db) => previewLink(db, pid, bid, { kind: 'edit', signingKey: cfg.signingKey, ttlSeconds: cfg.editLinkTtlSeconds }));
        return json(res, 200, { url: `/p/${link.token}`, before: `/p/${link.token}?view=before`, after: `/p/${link.token}?view=after`, expiresAt: link.expiresAt });
      }
    }
    if (c === 'links' && e === 'revoke') {
      const lid = id(d);
      const bd = await jsonBody(req);
      await tx((db) => revokeProspectLink(db, pid, lid, { revokedBy: String(bd.revokedBy ?? '') }));
      log(`link ${lid} revoked`);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found.');
  }

  /** The seller's view of a fix version's captured page or corrected copy, through an edit link only. */
  async function fixPage(res: ServerResponse, claims: NonNullable<ReturnType<typeof verifyPreview>>, view: 'before' | 'after', gone: () => void) {
    if (claims.k !== 'edit') return gone();
    const db = await cfg.pool.connect();
    let page: Buffer | null = null;
    try {
      await db.query('BEGIN READ ONLY');
      page = await withWorkspace(db, claims.w, () => readFixPage(db, cfg.store, claims.p, claims.b, view));
      await db.query('COMMIT');
    } catch {
      await db.query('ROLLBACK').catch(() => undefined);
      page = null;
    } finally {
      db.release();
    }
    if (!page) return gone();
    return send(res, 200, page, ARTIFACT_HEADERS);
  }

  /** GET /p/:token (the artifact) and /s/:token (the prospect's page around it). */
  async function preview(res: ServerResponse, kind: 'p' | 's', token: string, view: string | null = null) {
    const claims = verifyPreview(cfg.signingKey, token, Math.floor(Date.now() / 1000));
    const gone = () => send(res, 404, '<!doctype html><title>Preview unavailable</title><p style="font:16px system-ui;margin:40px">This preview link has expired or is not valid.</p>',
      { ...APP_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    if (!claims || (kind === 's' && claims.k !== 'show')) return gone();
    if (kind === 'p' && (view === 'before' || view === 'after')) return fixPage(res, claims, view, gone);
    const db = await cfg.pool.connect();
    let art;
    try {
      await db.query('BEGIN READ ONLY');
      art = await loadPreviewArtifact(db, cfg.store, claims);
      await db.query('COMMIT');
    } catch {
      await db.query('ROLLBACK').catch(() => undefined);
      art = null;
    } finally {
      db.release();
    }
    if (!art) return gone();
    if (kind === 'p') return send(res, 200, art.html, ARTIFACT_HEADERS);
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Design preview</title><link rel="stylesheet" href="/app.css"></head>
<body class="share"><div class="share-bar">${art.buildKind === 'website_fix'
    ? '<strong>Proposed fix</strong><span>A preview of a change to one link. Nothing on your live website has been changed.</span>'
    : '<strong>Design preview</strong><span>This is a proposal, not a live website. Nothing here is published.</span>'}</div>
<iframe class="share-frame" src="/p/${token}" title="Design preview" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe></body></html>`;
    return send(res, 200, page, { ...APP_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  }

  // Slice 10, Find: searches, provider discovery runs and selection for analysis.
  async function findApi(req: IncomingMessage, res: ServerResponse, parts: string[]) {
    const m = req.method;
    const [a, b, c, d, e] = parts;
    const providers = cfg.discovery?.providers ?? new DiscoveryProviderRegistry();
    // GET /api/discovery: the providers this server offers and the workspace's searches. Whether a
    // live provider is connected is all the screen learns about its credentials.
    if (m === 'GET' && a === 'discovery' && !b) {
      return json(res, 200, await tx(async (db) => {
        const conns = await db.query<{ provider: string }>(`SELECT DISTINCT provider FROM scopely.provider_connections
          WHERE workspace_id = scopely.current_workspace_id() AND state = 'ACTIVE' AND 'discovery' = ANY (scopes) AND credential_ref IS NOT NULL`);
        const connected = new Set(conns.rows.map((r) => r.provider));
        const runs = await db.query(`SELECT r.id, r.search_id, r.started_at, count(rb.id) AS discovered,
              count(rb.id) FILTER (WHERE rb.state = 'QUALIFIED') AS qualified
            FROM scopely.search_runs r LEFT JOIN scopely.search_run_businesses rb ON rb.search_run_id = r.id
           WHERE r.workspace_id = scopely.current_workspace_id() GROUP BY r.id ORDER BY r.started_at DESC, r.id DESC LIMIT 200`);
        return {
          providers: providers.list().map((p) => ({ key: p.provider, label: p.label, transport: p.transport,
            ready: p.transport === 'recorded' || (connected.has(p.provider) && Boolean(cfg.discovery?.secrets)) })),
          searches: await listSearches(db),
          runs: runs.rows.map((r) => ({ searchRunId: String(r.id), searchId: String(r.search_id), startedAt: new Date(r.started_at).toISOString(),
            discovered: Number(r.discovered), qualified: Number(r.qualified) })),
        };
      }));
    }
    // POST /api/searches: save an ICP.
    if (m === 'POST' && a === 'searches' && !b) {
      const input = searchInputFromBody(await jsonBody(req));
      const searchId = await tx((db) => createSearch(db, input));
      log(`search ${searchId} created`);
      return json(res, 200, { searchId });
    }
    // GET /api/searches/:id: the search as saved, with its runs.
    if (m === 'GET' && a === 'searches' && !c) {
      const sid = id(b);
      return json(res, 200, await tx(async (db) => {
        const s = await getSearch(db, sid);
        if (!s) throw new HttpError(404, 'Not found.');
        return s;
      }));
    }
    // POST /api/searches/:id/runs: run the search against a provider, then pre-qualify.
    if (m === 'POST' && a === 'searches' && c === 'runs' && !d) {
      const sid = id(b);
      const bd = await jsonBody(req);
      const provider = String(bd.provider ?? '');
      const out = await tx(async (db) => {
        if (!(await getSearch(db, sid))) throw new HttpError(404, 'Not found.');
        const runId = await startSearchRun(db, sid);
        const result = await runProviderDiscovery(db, { providers, secrets: cfg.discovery?.secrets }, runId, provider);
        return { searchRunId: runId, result };
      });
      log(`run ${out.searchRunId} search ${sid} ${provider} ${out.result.transport} ops=${out.result.operations} found=${out.result.discovered}${out.result.error ? ` ${out.result.error.code}` : ''}`);
      return json(res, 200, out);
    }
    // GET /api/runs/:id: the run in priority order, with what each provider call did.
    if (m === 'GET' && a === 'runs' && !c) {
      const rid = id(b);
      return json(res, 200, await tx(async (db) => {
        const v = await getRunDiscovery(db, rid);
        if (!v) throw new HttpError(404, 'Not found.');
        return v;
      }));
    }
    // POST /api/runs/:id/select: a person selects qualified businesses for analysis.
    if (m === 'POST' && a === 'runs' && c === 'select' && !d) {
      const rid = id(b);
      const sel = selectionFromBody(await jsonBody(req));
      try {
        await tx(async (db) => {
          if (!(await getRunDiscovery(db, rid))) throw new HttpError(404, 'Not found.');
          await selectForAnalysis(db, rid, sel.businessIds.map((businessId) => ({ businessId })), sel.selectedBy, new Date().toISOString());
        });
      } catch (err) {
        const words = err instanceof HttpError ? null : selectionRefusal((err as Error).message);
        if (words) throw new FindRejected(words);
        if (/is not in run/.test((err as Error).message)) throw new HttpError(404, 'Not found.');
        throw err;
      }
      log(`run ${rid} selected ${sel.businessIds.length}`);
      return json(res, 200, { selected: sel.businessIds.length });
    }
    // Slice 11. POST /api/runs/:id/businesses/:bid/analyze: Scopely analyses one selected business
    // (one request per business, so the screen can show progress). A second call returns the first
    // result without fetching again.
    if (m === 'POST' && a === 'runs' && c === 'businesses' && e === 'analyze' && parts.length === 5) {
      const rid = id(b);
      const bid = id(d);
      const bd = await jsonBody(req);
      const out = await tx(async (db) => {
        if (!(await getRunDiscovery(db, rid))) throw new HttpError(404, 'Not found.');
        const r = await analyzeRunBusiness(db, { probe }, rid, bid, String(bd.requestedBy ?? ''));
        return { ...r, analysis: await getRunBusinessAnalysis(db, rid, bid) };
      });
      log(`run ${rid} business ${bid} analysis ${out.analysisId} ${out.analysedNow ? 'new' : 'existing'} ${out.state} opportunities=${out.opportunityIds.length}`);
      return json(res, 200, out);
    }
    // GET /api/runs/:id/businesses/:bid/analysis: what that analysis observed and opened.
    if (m === 'GET' && a === 'runs' && c === 'businesses' && e === 'analysis' && parts.length === 5) {
      const rid = id(b);
      const bid = id(d);
      return json(res, 200, await tx(async (db) => {
        const v = await getRunBusinessAnalysis(db, rid, bid);
        if (!v) throw new HttpError(404, 'Not found.');
        return v;
      }));
    }
    throw new HttpError(404, 'Not found.');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const started = Date.now();
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]!;
        return send(res, 200, await readFile(path.join(UI_DIR, file)), { ...APP_HEADERS, 'content-type': type });
      }
      if (req.method === 'GET' && FONTS[url.pathname]) {
        return send(res, 200, await readFile(path.join(FONT_DIR, FONTS[url.pathname]!)),
          { ...APP_HEADERS, 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' });
      }
      const pm = /^\/(p|s)\/([A-Za-z0-9_.-]{20,700})$/.exec(url.pathname);
      if (req.method === 'GET' && pm) return await preview(res, pm[1] as 'p' | 's', pm[2]!, url.searchParams.get('view'));
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          // No cross-site writes: a browser form or another site's script cannot set this header.
          if (req.headers['x-scopely-request'] !== '1') throw new HttpError(403, 'Refused.');
          const origin = req.headers.origin;
          if (origin !== undefined && !sameHost(origin, req.headers.host)) throw new HttpError(403, 'Refused.');
        }
        return await api(req, res, url.pathname.slice(5).split('/').filter(Boolean), url);
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof SiteError) return json(res, err.status, { error: err.message });
      if (err instanceof OutcomeRejected) return json(res, err.status, { error: err.message });
      if (err instanceof ProspectRejected) return json(res, err.status, { error: err.message });
      if (err instanceof FindRejected) return json(res, err.status, { error: err.message });
      if (err instanceof AnalysisRefused) return json(res, err.status, { error: err.message });
      if (err instanceof DiscoveryRefused) return json(res, 422, { error: err.message, reason: err.reason });
      if (err instanceof ProspectLookupRefused) return json(res, err.reason === 'not_found' ? 404 : 422, { error: err.message, reason: err.reason });
      if (err instanceof EditRejected) return json(res, 400, { error: err.reason, index: err.index });
      const code = (err as { code?: string }).code ?? '';
      log(`error ${req.method} ${url.pathname.replace(/\/[A-Za-z0-9_.-]{20,}$/, '/…')} ${code}`);
      if (SCHEMA_BEHIND.has(code)) return json(res, 503, { error: SCHEMA_BEHIND_MESSAGE, reason: 'schema_behind' });
      return json(res, 500, { error: 'Something went wrong. Nothing was changed.' });
    } finally {
      if (url.pathname.startsWith('/api/')) log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };
}
