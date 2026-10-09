// Slice 8: the product shell and the Case File. The product lives under /app and the root is the
// landing page's place (U2); the feed and the Case File show only stored values; a seller records
// a pitch and its outcome by hand (U4), through the append-only ledger, and Scopely sends nothing.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { stageOf } from '../src/api/case-file.js';
import { DEFAULT_SHOW_LINK_TTL_SECONDS } from '../src/build/site/index.js';
import { createHandler } from '../src/server/app.js';
import { OutcomeRejected, occurredAt } from '../src/sell/outcomes.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { StubFetcher, seedFixOpportunity } from './fix-helpers.js';
import { enterNewWorkspace, one, seedChain, seedOpportunity, useDb, useWorkspace } from './helpers.js';
import { SIGNING_KEY, confirmRecheck, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();

function poolOver(client: pg.Client): pg.Pool {
  const map: Record<string, string> = {
    BEGIN: 'SAVEPOINT srv', 'BEGIN READ ONLY': 'SAVEPOINT srv', COMMIT: 'RELEASE SAVEPOINT srv', ROLLBACK: 'ROLLBACK TO SAVEPOINT srv',
  };
  const conn = { query: (sql: string, params?: unknown[]) => client.query(map[sql] ?? sql, params), release: () => undefined };
  return { connect: async () => conn } as unknown as pg.Pool;
}

let server: http.Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function start(workspaceId?: string) {
  const ws = workspaceId ?? (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
  const logged: string[] = [];
  const handler = createHandler({ pool: poolOver(db()), store: new MemoryObjectStore(), workspaceId: ws, signingKey: SIGNING_KEY,
    fetcher: new StubFetcher(), editLinkTtlSeconds: 900, showLinkTtlSeconds: DEFAULT_SHOW_LINK_TTL_SECONDS, log: (l: string) => { logged.push(l); } });
  server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-scopely-request': '1' }) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) };
  };
  return { call, logged, workspaceId: ws };
}

const today = () => new Date().toISOString().slice(0, 10);

describe('product shell routes (U2)', () => {
  it('serves the product at /app and keeps the root for the landing page, under the app policy', async () => {
    const { call } = await start();
    const app = await call('GET', '/app');
    expect(app.status).toBe(200);
    expect(app.text).toContain('/shell.css');
    expect(app.text).toContain('/app.js');
    expect(app.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect((await call('GET', '/app/')).status).toBe(200);
    const root = await call('GET', '/');
    expect(root.status).toBe(200);
    expect(root.text).toContain('href="/app"');
    expect(root.text).not.toContain('/app.js');
    expect(root.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect((await call('GET', '/landing.css')).headers.get('content-type')).toMatch(/text\/css/);
    for (const f of ['/shell.js', '/case-file.js', '/map-slot.js', '/lib.js', '/landing.js']) {
      const r = await call('GET', f);
      expect(r.status, f).toBe(200);
      expect(r.headers.get('content-type'), f).toMatch(/javascript/);
    }
    expect((await call('GET', '/shell.css')).headers.get('content-type')).toMatch(/text\/css/);
  });

  it('the landing page leads to /app, labels its example as demo data, and claims nothing that is not built (L1–L3)', async () => {
    const { call } = await start();
    const page = (await call('GET', '/')).text;
    // L3: out of search engines until launch; the product keeps its own noindex.
    expect(page).toMatch(/<meta name="robots" content="noindex,nofollow">/);
    expect((await call('GET', '/app')).text).toMatch(/<meta name="robots" content="noindex,nofollow">/);
    // L1: every call to action opens the product, and there is no form collecting details.
    const ctas = [...page.matchAll(/<a class="btn[^"]*" href="([^"]+)">([^<]+)<\/a>/g)].filter((m) => m[2] === 'Open Scopely');
    expect(ctas.length).toBeGreaterThanOrEqual(3);
    for (const m of ctas) expect(m[1]).toBe('/app');
    expect(page).not.toMatch(/<form|<input|mailto:/i);
    // L2: the example Case File is the demo seed's fictional business, labelled as demo data.
    const demo = page.slice(page.indexOf('<figure'), page.indexOf('</figure>'));
    expect(demo).toContain('Demo data');
    expect(demo).toContain('harbourlane.example');
    expect(demo).toMatch(/fictional business/);
    expect(page.match(/\.example\b/g)!.length).toBe(page.slice(page.indexOf('<figure'), page.indexOf('</figure>')).match(/\.example\b/g)!.length);
    // Deliver and Verify stay planned, wherever they appear.
    const steps = page.slice(page.indexOf('class="lp-steps"'), page.indexOf('</ol>', page.indexOf('class="lp-steps"')));
    for (const stage of ['Deliver', 'Verify']) expect(steps).toMatch(new RegExp(`<h3>${stage} <span class="plan">PLANNED</span></h3>`));
    expect(demo).toMatch(/Deliver · verify · get paid<\/b> <span class="plan">PLANNED<\/span>/);
    // No invented results: no percentages, customer counts or testimonials.
    expect(page).not.toMatch(/\d+\s*%|testimonial|customers? (?:love|trust)|\d+[,\d]* (?:businesses|clients|customers)/i);
  });

  it('keeps the map a placeholder: no provider, tiles or coordinates (U3)', async () => {
    const { call } = await start();
    const slot = (await call('GET', '/map-slot.js')).text;
    const shell = (await call('GET', '/shell.js')).text;
    for (const src of [slot, shell]) {
      expect(src).not.toMatch(/leaflet|mapbox|maplibre|googleapis|openstreetmap|tile\.|latitude|longitude/i);
    }
    expect(slot).toContain('PLANNED');
  });

  it('says whose workspace the app acts for, and that no one is signed in', async () => {
    const { call } = await start();
    const w = await call('GET', '/api/workspace');
    expect(w.status).toBe(200);
    expect(w.json()).toMatchObject({ authenticated: false });
    expect(typeof w.json().name).toBe('string');
  });

  it('animates the landing page only as an enhancement: nothing is hidden without JavaScript or with reduced motion', async () => {
    const { call } = await start();
    const page = (await call('GET', '/')).text;
    const css = (await call('GET', '/landing.css')).text.replace(/\/\*[\s\S]*?\*\//g, '');
    const js = (await call('GET', '/landing.js')).text;
    // Same-origin script only: no animation library, no inline script (the CSP allows neither).
    expect([...page.matchAll(/<script[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="/landing.js">']);
    // Every hidden starting state is armed by landing.js (html.lp-motion) and sits inside the
    // no-preference block, so reduced motion and a failed script both leave every section visible.
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'), css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(motion.length).toBeGreaterThan(0);
    const outside = css.replace(motion, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');
    expect(outside).not.toMatch(/opacity:\s*0\s*[;}]/);
    expect(outside).not.toMatch(/animation:(?!\s*none)/);
    for (const rule of motion.match(/[^{}]+\{[^{}]*opacity:\s*0\s*[;}]/g) ?? []) expect(rule.trim()).toMatch(/^\.lp-motion /);
    // Entrance animations fill backwards only, so hover and pressed states still apply afterwards.
    for (const a of motion.match(/animation:[^;]+;/g) ?? []) {
      if (!/infinite/.test(a)) expect(a).toMatch(/backwards/);
    }
    // The script arms reveals only when they can run, and takes them off again if anything fails.
    expect(js).toMatch(/'IntersectionObserver' in window && !reduce\.matches/);
    expect(js).toMatch(/catch \{\s*root\.classList\.remove\('lp-motion'\)/);
    expect(js).not.toMatch(/setInterval|setTimeout/);
    // Hover is never the only way to see something: hover rules change emphasis, not visibility.
    for (const rule of css.match(/[^{}]*:hover[^{}]*\{[^{}]*\}/g) ?? []) expect(rule).not.toMatch(/display|visibility|opacity/);
  });
});

describe('stageOf', () => {
  it('places an opportunity by its furthest stored state', () => {
    expect(stageOf({ buildState: 'NONE', sellState: 'NOT_STARTED', deliveryState: 'NONE' })).toBe('OPPORTUNITIES');
    expect(stageOf({ buildState: 'DRAFT', sellState: 'NOT_STARTED', deliveryState: 'NONE' })).toBe('BUILD');
    expect(stageOf({ buildState: 'APPROVED', sellState: 'PITCHED', deliveryState: 'NONE' })).toBe('SELL');
    expect(stageOf({ buildState: 'NONE', sellState: 'LOST', deliveryState: 'NONE' })).toBe('SELL');
    expect(stageOf({ buildState: 'SHOWN', sellState: 'WON', deliveryState: 'NONE' })).toBe('DELIVER');
    expect(stageOf({ buildState: 'SHOWN', sellState: 'WON', deliveryState: 'VERIFIED_FIXED' })).toBe('VERIFY');
  });
});

describe('the feed', () => {
  it('lists both paths with their stored facts and the observed problem, and invents nothing', async () => {
    const web = await seedWebsiteOpportunity(db(), { reviews: true });
    const fix = await seedFixOpportunity(db());
    const { call } = await start();
    const feed = (await call('GET', '/api/opportunities')).json() as Record<string, unknown>[];
    const w = feed.find((o) => o.opportunityId === web.opportunityId)!;
    const f = feed.find((o) => o.opportunityId === fix.opportunityId)!;
    expect(w).toMatchObject({ path: 'WEBSITE', stage: 'OPPORTUNITIES', buildable: true, captured: false, sellState: 'NOT_STARTED',
      city: 'London', vertical: 'aesthetics', rating: '4.80', reviewCount: 132 });
    expect(f).toMatchObject({ path: 'FIX', stage: 'OPPORTUNITIES', fixable: true, captured: false });
    expect(f.observed).toMatchObject({ claimState: 'OBSERVED', text: 'WhatsApp: 0800', quote: 'href="tel:WhatsApp:0800"' });
    // A price only when one was set: the website catalog item has none.
    expect(w.price).toBeNull();
  });

  it('moves an opportunity to Build once a project opens, and marks a fix captured', async () => {
    const fix = await seedFixOpportunity(db());
    const { call } = await start();
    const { projectId } = (await call('POST', `/api/opportunities/${fix.opportunityId}/fix`)).json();
    expect((await call('POST', `/api/fix/${projectId}/capture`, { evidenceId: fix.evidenceId })).status).toBe(200);
    const f = ((await call('GET', '/api/opportunities')).json() as Record<string, unknown>[]).find((o) => o.opportunityId === fix.opportunityId)!;
    expect(f).toMatchObject({ captured: true, fixProjectId: projectId });
  });
});

describe('the Case File', () => {
  it('answers every section from stored values, without storage keys or hashes', async () => {
    const web = await seedWebsiteOpportunity(db());
    const { call } = await start();
    const r = await call('GET', `/api/opportunities/${web.opportunityId}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/workspaces\//);
    expect(r.text).not.toMatch(/\b[0-9a-f]{64}\b/);
    const cf = r.json();
    expect(cf).toMatchObject({ opportunityId: web.opportunityId, path: 'WEBSITE', stage: 'OPPORTUNITIES' });
    expect(cf.evidence[0]).toMatchObject({ evidenceId: web.evidenceId, claimState: 'OBSERVED', visibleText: 'WhatsApp: 0800' });
    expect(cf.business).toMatchObject({ businessId: web.businessId, name: 'Example Clinic' });
    expect(cf.service).toMatchObject({ mappingStatus: 'MAPPED', catalogKey: 'website_build', price: null });
    expect(cf.build).toMatchObject({ builder: 'website', projectId: null, canStart: true, blocker: null, current: null, showLink: null });
    expect(cf.buyer.contacts).toEqual([]);
    // The HIGH finding has not been re-checked, so the outreach section says so.
    expect(cf.outreach.recheckNeeded).toEqual([expect.objectContaining({ evidenceId: web.evidenceId })]);
    expect(cf.sell).toMatchObject({ sellState: 'NOT_STARTED', agreedAmount: null, outcomes: [], terminalOutcomeId: null,
      can: { pitched: true, replied: false, call: false, won: false, lost: false, voided: false } });
    await confirmRecheck(db(), web);
    expect((await call('GET', `/api/opportunities/${web.opportunityId}`)).json().outreach.recheckNeeded).toEqual([]);
  });

  it('shows a contact with the database gate on emailing it', async () => {
    const web = await seedWebsiteOpportunity(db());
    await db().query(`INSERT INTO contacts (business_id, full_name, role, email, email_kind, source, label, outreach_basis, verification_basis)
                      VALUES ($1, 'Sam Alder', 'Practice manager', 'sam@example-clinic.test', 'role', 'website_contact_page', 'PUBLICLY_FOUND', 'unknown', NULL),
                             ($1, 'Kit Moss', 'Owner', 'kit@example-clinic.test', 'personal', 'manual', 'VERIFIED', 'consent', 'Confirmed by phone')`, [web.businessId]);
    const { call } = await start();
    const contacts = (await call('GET', `/api/opportunities/${web.opportunityId}`)).json().buyer.contacts as { name: string; emailBlocker: string | null }[];
    expect(contacts.find((c) => c.name === 'Sam Alder')!.emailBlocker).toMatch(/outreach basis is unknown/);
    expect(contacts.find((c) => c.name === 'Kit Moss')!.emailBlocker).toBeNull();
  });

  it('carries the fix steps for a fix, and tells the builders where to return', async () => {
    const fix = await seedFixOpportunity(db());
    const web = await seedWebsiteOpportunity(db());
    const { call } = await start();
    const fixPid = (await call('POST', `/api/opportunities/${fix.opportunityId}/fix`)).json().projectId;
    const webPid = (await call('POST', `/api/opportunities/${web.opportunityId}/website`)).json().projectId;
    const cf = (await call('GET', `/api/opportunities/${fix.opportunityId}`)).json();
    expect(cf.build).toMatchObject({ builder: 'fix', projectId: fixPid, fix: { captured: null, correction: null } });
    expect(cf.build.fix.steps).toBeTruthy();
    expect((await call('GET', `/api/fix/${fixPid}`)).json().project.opportunityId).toBe(fix.opportunityId);
    expect((await call('GET', `/api/projects/${webPid}/setup`)).json().opportunityId).toBe(web.opportunityId);
  });

  it('opens nothing and records nothing in another workspace', async () => {
    const web = await seedWebsiteOpportunity(db());
    const home = (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;
    const other = await enterNewWorkspace(db(), 'other');
    const { call } = await start(other);
    expect((await call('GET', `/api/opportunities/${web.opportunityId}`)).status).toBe(404);
    const rec = await call('POST', `/api/opportunities/${web.opportunityId}/outcomes`, { kind: 'pitched', occurredOn: today(), recordedBy: 'Sam', channel: 'email' });
    expect(rec.status).toBe(404);
    expect(((await call('GET', '/api/opportunities')).json() as unknown[]).length).toBe(0);
    await useWorkspace(db(), home);
    expect((await one<{ n: number }>(db(), 'SELECT count(*)::int AS n FROM outcomes WHERE opportunity_id = $1', [web.opportunityId])).n).toBe(0);
  });
});

describe('recording a sale by hand (U4)', () => {
  async function priced() {
    const chain = await seedChain(db());
    const opportunityId = await seedOpportunity(db(), chain);
    const srv = await start();
    const rec = (body: Record<string, unknown>) => srv.call('POST', `/api/opportunities/${opportunityId}/outcomes`,
      { occurredOn: today(), recordedBy: 'Sam', ...body });
    const cf = async () => (await srv.call('GET', `/api/opportunities/${opportunityId}`)).json();
    return { ...srv, opportunityId, rec, cf };
  }

  it('refuses a write without the app header or from another origin', async () => {
    const { call, opportunityId } = await priced();
    const body = { kind: 'pitched', occurredOn: today(), recordedBy: 'Sam', channel: 'email' };
    expect((await call('POST', `/api/opportunities/${opportunityId}/outcomes`, body, {})).status).toBe(403);
    expect((await call('POST', `/api/opportunities/${opportunityId}/outcomes`, body, { 'x-scopely-request': '1', origin: 'https://evil.test' })).status).toBe(403);
  });

  it('records a pitch, a reply and a win with the agreed amount, and never calls it a payment', async () => {
    const { rec, cf, logged } = await priced();
    expect((await rec({ kind: 'won', amount: 120 })).json().error).toMatch(/pitch first/i);
    expect((await rec({ kind: 'pitched' })).status).toBe(400);
    expect((await rec({ kind: 'pitched', channel: 'email', amount: 50 })).status).toBe(400);
    expect((await rec({ kind: 'pitched', channel: 'carrier-pigeon' })).status).toBe(400);
    expect((await rec({ kind: 'pitched', channel: 'email', notes: 'Showed the preview on a call' })).status).toBe(200);
    expect((await rec({ kind: 'replied', channel: 'email' })).status).toBe(400);
    expect((await rec({ kind: 'replied', channel: 'email', replyClass: 'positive' })).status).toBe(200);
    expect((await rec({ kind: 'won' })).status).toBe(400);
    expect((await rec({ kind: 'won', amount: '-5' })).status).toBe(400);
    const wrong = await rec({ kind: 'won', amount: 120, currency: 'EUR' });
    expect(wrong.status).toBe(409);
    expect(wrong.json().error).toMatch(/GBP/);
    expect((await rec({ kind: 'won', amount: '120' })).status).toBe(200);
    const s = (await cf()).sell;
    expect(s).toMatchObject({ sellState: 'WON', agreedAmount: '120.00', currency: 'GBP', deliveryState: 'AWAITING_DELIVERY',
      can: { pitched: true, won: false, lost: false, voided: true } });
    expect(s.outcomes.map((o: { kind: string }) => o.kind)).toEqual(['pitched', 'replied', 'won']);
    expect((await cf()).stage).toBe('DELIVER');
    // Logs name ids and the kind, never the notes.
    expect(logged.join('\n')).not.toContain('Showed the preview');
  });

  it('allows one result, corrected only by a voided record with a reason', async () => {
    const { rec, cf } = await priced();
    await rec({ kind: 'pitched', channel: 'phone' });
    const won = (await rec({ kind: 'won', amount: 120 })).json().outcomeId;
    const second = await rec({ kind: 'lost' });
    expect(second.status).toBe(409);
    expect(second.json().error).toMatch(/already marked won or lost/);
    expect((await rec({ kind: 'voided', correctsOutcomeId: won })).status).toBe(400);
    expect((await rec({ kind: 'voided', correctsOutcomeId: won, notes: 'Entered on the wrong business' })).status).toBe(200);
    expect((await rec({ kind: 'voided', correctsOutcomeId: won, notes: 'again' })).status).toBe(409);
    expect((await rec({ kind: 'lost', notes: 'Went with their current agency' })).status).toBe(200);
    const s = (await cf()).sell;
    expect(s.sellState).toBe('LOST');
    expect(s.agreedAmount).toBeNull();
    expect(s.outcomes.find((o: { outcomeId: string }) => o.outcomeId === won)).toMatchObject({ voided: true });
    // The ledger stayed append-only: the win is still there.
    expect(s.outcomes.map((o: { kind: string }) => o.kind)).toEqual(['pitched', 'won', 'voided', 'lost']);
  });

  it('never records a delivery, and refuses a future date', async () => {
    const { rec } = await priced();
    await rec({ kind: 'pitched', channel: 'email' });
    expect((await rec({ kind: 'delivered' })).status).toBe(400);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await rec({ kind: 'call', occurredOn: future })).status).toBe(400);
    expect((await rec({ kind: 'call', recordedBy: ' ' })).status).toBe(400);
  });

  it('takes a typed currency only when the opportunity has none', async () => {
    const web = await seedWebsiteOpportunity(db());
    const { call } = await start();
    const rec = (body: Record<string, unknown>) => call('POST', `/api/opportunities/${web.opportunityId}/outcomes`, { occurredOn: today(), recordedBy: 'Sam', ...body });
    await rec({ kind: 'pitched', channel: 'in_person' });
    expect((await rec({ kind: 'won', amount: 900 })).status).toBe(400);
    expect((await rec({ kind: 'won', amount: 900, currency: 'gbp' })).status).toBe(200);
    expect((await call('GET', `/api/opportunities/${web.opportunityId}`)).json().sell).toMatchObject({ agreedAmount: '900.00', currency: 'GBP' });
  });
});

describe('occurredAt', () => {
  const now = new Date('2026-09-29T15:30:00Z');
  it('turns a day into a time without inventing one', () => {
    expect(occurredAt('2026-09-29', now)).toBe(now.toISOString());
    expect(occurredAt('2026-09-30', now)).toBe(now.toISOString());
    expect(occurredAt('2026-09-20', now)).toBe('2026-09-20T12:00:00.000Z');
    expect(() => occurredAt('2026-10-02', now)).toThrow(OutcomeRejected);
    expect(() => occurredAt('29/09/2026', now)).toThrow(OutcomeRejected);
    expect(() => occurredAt('2026-13-40', now)).toThrow(OutcomeRejected);
  });
});
