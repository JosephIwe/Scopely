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
import { listOpportunities } from '../api/queries.js';
import { OutcomeRejected, recordManualOutcome } from '../sell/outcomes.js';
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
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
// U2: the root is the landing page's place; the product lives under /app. The landing page itself
// is not built yet, so / is a plain boundary page that points to /app.
const STATIC: Record<string, [string, string]> = {
  '/': ['landing.html', 'text/html; charset=utf-8'],
  '/landing.js': ['landing.js', 'text/javascript; charset=utf-8'],
  '/app': ['index.html', 'text/html; charset=utf-8'],
  '/app/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
  '/shell.js': ['shell.js', 'text/javascript; charset=utf-8'],
  '/case-file.js': ['case-file.js', 'text/javascript; charset=utf-8'],
  '/map-slot.js': ['map-slot.js', 'text/javascript; charset=utf-8'],
  '/shell.css': ['shell.css', 'text/css; charset=utf-8'],
};

/** The workspace's own typefaces (the same files the site template embeds). */
const FONTS: Record<string, string> = {
  '/fonts/geist.woff2': 'geist-latin-wght.woff2',
  '/fonts/geist-mono-400.woff2': 'geist-mono-latin-400.woff2',
  '/fonts/geist-mono-500.woff2': 'geist-mono-latin-500.woff2',
  '/fonts/instrument-serif.woff2': 'instrument-serif-latin-400.woff2',
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

export function createHandler(cfg: ServerConfig) {
  const log = cfg.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const fetcher = cfg.fetcher ?? new SafePageFetcher();

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
        return { ...cf, build: { ...cf.build, showLink, fix } };
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
      if (err instanceof EditRejected) return json(res, 400, { error: err.reason, index: err.index });
      log(`error ${req.method} ${url.pathname.replace(/\/[A-Za-z0-9_.-]{20,}$/, '/…')} ${(err as { code?: string }).code ?? ''}`);
      return json(res, 500, { error: 'Something went wrong. Nothing was changed.' });
    } finally {
      if (url.pathname.startsWith('/api/')) log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };
}
