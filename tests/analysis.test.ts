// Slice 11: ANALYZE → evidence → OPPORTUNITY for a business selected in a search run. Scopely
// requests the business's own page (here, from a table instead of the network), records what it
// observed in OBSERVED / INFERRED / NOT_OBSERVABLE, turns only OBSERVED defects with an issue code
// into evidence, and opens an opportunity only where the catalog maps the finding to a service.
import { describe, expect, it } from 'vitest';
import {
  AnalysisRefused, addressToAnalyse, analyzeRunBusiness, contactKind, mailDefect, readPage, SafeProbe, telDefect, whatsappDefect,
} from '../src/analysis/index.js';
import { getRunBusinessAnalysis } from '../src/api/analysis.js';
import { getCaseFile } from '../src/api/case-file.js';
import { getRunDiscovery } from '../src/api/discovery.js';
import { captureFixPage, openFixProject } from '../src/build/fix/index.js';
import { classifyWebsiteFetch } from '../src/discovery/website.js';
import { recordCaseRecheck } from '../src/sell/prospect.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { AT, BOOKING, CLINIC, PLATFORM, TableProbe, runBusiness, seedRun } from './analysis-helpers.js';
import { StubFetcher } from './fix-helpers.js';
import { asApp, enterNewWorkspace, failure, one, refused, useDb, useWorkspace } from './helpers.js';

const { db } = useDb();
const now = () => new Date(AT);
const analyse = (probe: TableProbe, runId: string, businessId: string, by = 'Seller') => analyzeRunBusiness(db(), { probe, now }, runId, businessId, by);
const currentWs = async () => (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

async function clinic(opts: { kinds?: string[] } = {}) {
  const { runId, searchId } = await seedRun(db(), opts);
  const businessId = await runBusiness(db(), runId, { domain: 'harbourclinic.test' });
  const probe = new TableProbe({ 'https://harbourclinic.test/': { html: CLINIC } });
  return { runId, searchId, businessId, probe };
}

const evidenceOf = async (analysisId: string) => (await db().query(
  `SELECT e.*, o.href, o.check_code, rv.rule_key, rv.version, s.fetched_at AS snap_at, s.analysis_id
     FROM evidence e JOIN observations o ON o.id = e.observation_id JOIN snapshots s ON s.id = o.snapshot_id
     JOIN rule_versions rv ON rv.id = e.rule_version_id WHERE s.analysis_id = $1 ORDER BY e.id`, [analysisId])).rows;

describe('reading a served page', () => {
  it('finds links, forms and resources outside comments and scripts, and quotes each link as served', () => {
    const f = readPage(CLINIC);
    expect(f.title).toBe('Harbour Clinic');
    expect(f.viewport).toMatch(/device-width/);
    expect(f.links.map((l) => l.href)).not.toContain('tel:+4400000');            // inside a script
    expect(f.links.map((l) => l.href)).not.toContain('https://wa.me/07700900461'); // inside a comment
    const wa = f.links.find((l) => l.label === 'WhatsApp us')!;
    expect(CLINIC).toContain(wa.raw);
    expect(wa.raw).toBe('<a class="wa" href="https://api.whatsapp.com/send?phone=07700900461">WhatsApp us</a>');
    expect(f.forms).toEqual([{ action: '/enquire', method: 'post', fields: 2 }]);
  });

  it('judges contact links the way check.contact_links describes, and only those shapes', () => {
    expect(telDefect('tel:WhatsApp:0800')).toMatch(/letters/);
    expect(telDefect('tel:+4402079460000')).toMatch(/keeps the 0 after \+44/);
    expect(telDefect('tel:+44 (0)20 7946 0000')).toMatch(/keeps the 0/);
    expect(telDefect('tel:123')).toMatch(/too few digits/);
    expect(telDefect('tel:020 7946 0000')).toBeNull();
    expect(telDefect('tel:+1-416-555-0100')).toBeNull();
    expect(whatsappDefect('https://api.whatsapp.com/send?phone=07858668579').defect).toMatch(/without a country code/);
    expect(whatsappDefect('https://wa.me/').defect).toMatch(/no number/);
    expect(whatsappDefect('https://wa.me/447700900123')).toEqual({ defect: null, judged: true });
    expect(whatsappDefect('https://wa.me/message/ABCDEF')).toEqual({ defect: null, judged: false });
    expect(mailDefect('mailto:info@bronte-clinic-old.local')).toMatch(/reserved domain/);
    expect(mailDefect('mailto:hello@yourdomain.com')).toMatch(/placeholder/);
    expect(mailDefect('mailto:not an address')).toMatch(/not an email address/);
    expect(mailDefect('mailto:team@clinic.co.uk?subject=Hi')).toBeNull();
    expect(contactKind('https://wa.me/447700900123')).toBe('whatsapp');
    expect(contactKind('https://example.com/whatsapp')).toBeNull();
  });

  it('asks for the recorded website, else the domain over HTTPS, else nothing', () => {
    expect(addressToAnalyse({ website_url: 'http://www.clinic.test', domain: 'clinic.test' })).toBe('http://www.clinic.test');
    expect(addressToAnalyse({ website_url: 'www.clinic.test/home', domain: null })).toBe('https://www.clinic.test/home');
    expect(addressToAnalyse({ website_url: null, domain: 'Clinic.test' })).toBe('https://clinic.test/');
    expect(addressToAnalyse({ website_url: null, domain: null })).toBeNull();
  });
});

describe('analysing a selected business', () => {
  it('records the page, its observations and evidence, and opens one Fix opportunity for the mapped findings', async () => {
    const { runId, businessId, probe } = await clinic();
    const r = await analyse(probe, runId, businessId);
    expect(r).toMatchObject({ analysedNow: true, state: 'OPPORTUNITY_FOUND' });
    expect(r.opportunityIds).toHaveLength(1);
    expect(probe.calls.map((c) => c.url)).toEqual(['https://harbourclinic.test/']);

    const ev = await evidenceOf(r.analysisId);
    expect(ev.map((e) => e.issue_code).sort()).toEqual(['E-EMAIL-INVALID', 'E-LINK-TARGET-MISMATCH', 'E-TEL-BROKEN', 'E-WA-BROKEN']);
    for (const e of ev) {
      // Provenance: exact link as served, the page it was on, the snapshot's time, the automated rule.
      expect(CLINIC).toContain(e.quote);
      expect(e.url).toBe('https://harbourclinic.test/');
      expect(new Date(e.observed_at).toISOString()).toBe(new Date(e.snap_at).toISOString());
      expect(new Date(e.observed_at).toISOString()).toBe(AT);
      expect(`${e.rule_key}@${e.version}`).toBe('check.contact_links@2');
      expect(e.claim_state).toBe('OBSERVED');
      expect(e.confidence).toBe('HIGH');
      expect(e.analysis_id).toBe(r.analysisId);
    }
    const wa = ev.find((e) => e.issue_code === 'E-WA-BROKEN')!;
    expect(wa.href).toBe('https://api.whatsapp.com/send?phone=07700900461');
    expect(wa.plain_issue).toBe('The "WhatsApp us" WhatsApp link uses 07700900461 without a country code, which WhatsApp cannot open');

    const opp = await one<Record<string, any>>(db(), `SELECT o.*, c.key FROM opportunities o JOIN catalog_items c ON c.id = o.catalog_item_id WHERE o.id = $1`, [r.opportunityIds[0]]);
    expect(opp).toMatchObject({ key: 'website_fix_sprint', opportunity_kind: 'website_fix', mapping_status: 'MAPPED', opportunity_type: 'broken_contact_path',
      search_run_id: runId, service_price: null, currency: null, why_it_matters: null });
    expect(opp.not_observable_notes).toMatch(/Whether the published email addresses accept mail is not checked/);
    const linked = (await db().query('SELECT evidence_id FROM opportunity_evidence WHERE opportunity_id = $1', [opp.id])).rows;
    expect(linked).toHaveLength(4);

    const b = await one<Record<string, any>>(db(), 'SELECT website_status, website_status_basis, website_status_source FROM businesses WHERE id = $1', [businessId]);
    expect(b).toEqual({ website_status: 'WEBSITE_PRESENT', website_status_basis: 'OBSERVED', website_status_source: 'scopely:scopely.static/1' });
    const rb = await one<Record<string, any>>(db(), 'SELECT state, queued_at, analyzed_at, concluded_at FROM search_run_businesses WHERE search_run_id = $1 AND business_id = $2', [runId, businessId]);
    expect(rb.state).toBe('OPPORTUNITY_FOUND');
    // One fetch, metered with no amount and no credits: Scopely has no price for its own requests.
    const cost = (await db().query(`SELECT kind, amount, credits, search_run_id, meta FROM cost_events WHERE business_id = $1`, [businessId])).rows;
    expect(cost).toEqual([{ kind: 'fetch', amount: null, credits: null, search_run_id: runId, meta: expect.objectContaining({ purpose: 'analysis', request: 'page' }) }]);
    // The page itself is never stored: only its hash.
    const snap = await one<Record<string, any>>(db(), 'SELECT html_sha256, html_ref, fetch_method, http_status FROM snapshots WHERE analysis_id = $1', [r.analysisId]);
    expect(snap).toMatchObject({ html_ref: null, fetch_method: 'http', http_status: 200 });
    expect(snap.html_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records what it could see in the three honest states, and never claims absence', async () => {
    const { runId, businessId, probe } = await clinic();
    const r = await analyse(probe, runId, businessId);
    const v = (await getRunBusinessAnalysis(db(), runId, businessId))!;
    const by = (code: string) => v.observations.filter((o) => o.checkCode === code);
    expect(by('website_presence.fetch')[0]).toMatchObject({ state: 'OBSERVED', result: 'ok', rule: 'check.website_presence@1' });
    expect(by('page_signals.https')[0]).toMatchObject({ state: 'OBSERVED', result: 'ok' });
    expect(by('page_signals.forms')[0]).toMatchObject({ state: 'OBSERVED', result: 'ok' });
    expect(by('page_signals.meaningful_presence')[0]).toMatchObject({ state: 'INFERRED', result: 'ok' });
    // No booking platform in the HTML is NOT_OBSERVABLE, never "no booking".
    expect(by('booking_platform_fingerprint.platform')[0]).toMatchObject({ state: 'NOT_OBSERVABLE', result: null });
    const inferred = await one<{ inferred_from: string[] }>(db(),
      `SELECT o.inferred_from FROM observations o JOIN snapshots s ON s.id = o.snapshot_id WHERE s.analysis_id = $1 AND o.check_code = 'page_signals.meaningful_presence'`, [r.analysisId]);
    expect(inferred.inferred_from.length).toBe(3);
    // Nothing NOT_OBSERVABLE or INFERRED became evidence.
    const bad = await db().query(`SELECT 1 FROM evidence e JOIN observations o ON o.id = e.observation_id WHERE o.state <> 'OBSERVED' AND e.business_id = $1`, [businessId]);
    expect(bad.rows).toHaveLength(0);
    expect(v.findings.every((f) => f.note === 'opened')).toBe(true);
  });

  it('gives the same observations for the same page in another workspace (deterministic)', async () => {
    const first = await clinic();
    const a = await analyse(first.probe, first.runId, first.businessId);
    const obsOf = async (id: string) => (await db().query(
      `SELECT o.check_code, o.state, o.result, o.href, o.visible_text, o.extracted - 'analyzer' AS x FROM observations o JOIN snapshots s ON s.id = o.snapshot_id
        WHERE s.analysis_id = $1 ORDER BY o.id`, [id])).rows;
    const one1 = await obsOf(a.analysisId);
    await enterNewWorkspace(db(), 'second');
    const second = await clinic();
    const b = await analyse(second.probe, second.runId, second.businessId);
    expect(await obsOf(b.analysisId)).toEqual(one1);
  });

  it('records redirects and cites the final page', async () => {
    const { runId } = await seedRun(db());
    const businessId = await runBusiness(db(), runId, { domain: 'redirects.test', websiteUrl: 'http://redirects.test' });
    const probe = new TableProbe({ 'http://redirects.test': { html: CLINIC, finalUrl: 'https://www.redirects.test/',
      redirectFrom: [{ url: 'http://redirects.test/', status: 301 }, { url: 'https://redirects.test/', status: 302 }] } });
    const r = await analyse(probe, runId, businessId);
    const snap = await one<Record<string, any>>(db(), 'SELECT url, final_url, redirect_chain FROM snapshots WHERE analysis_id = $1', [r.analysisId]);
    expect(snap).toEqual({ url: 'http://redirects.test', final_url: 'https://www.redirects.test/',
      redirect_chain: [{ url: 'http://redirects.test/', status: 301 }, { url: 'https://redirects.test/', status: 302 }] });
    expect((await evidenceOf(r.analysisId)).every((e) => e.url === 'https://www.redirects.test/')).toBe(true);
    const v = (await getRunBusinessAnalysis(db(), runId, businessId))!;
    expect(v.observations.find((o) => o.checkCode === 'website_presence.fetch')!.fact).toMatch(/after 2 redirects/);
  });

  it('notes a site served over plain HTTP as an observed fact, not a finding', async () => {
    const { runId } = await seedRun(db());
    const businessId = await runBusiness(db(), runId, { domain: 'plain.test', websiteUrl: 'http://plain.test/' });
    const r = await analyse(new TableProbe({ 'http://plain.test/': { html: '<title>Plain</title><p>A small site.</p>' } }), runId, businessId);
    const v = (await getRunBusinessAnalysis(db(), runId, businessId))!;
    expect(v.observations.find((o) => o.checkCode === 'page_signals.https')).toMatchObject({ state: 'OBSERVED', result: 'gap' });
    expect(r.state).toBe('NO_OPPORTUNITY');
    expect(v.findings).toHaveLength(0);
  });

  it('treats an unreachable site as unreachable, never as "no website", and opens nothing', async () => {
    const { runId } = await seedRun(db());
    const gone = await runBusiness(db(), runId, { domain: 'gone.test' });
    const slow = await runBusiness(db(), runId, { domain: 'slow.test' });
    const walled = await runBusiness(db(), runId, { domain: 'walled.test' });
    const probe = new TableProbe({ 'https://slow.test/': { error: 'timeout' }, 'https://walled.test/': { status: 403 } });
    for (const b of [gone, slow, walled]) expect((await analyse(probe, runId, b)).state).toBe('NO_OPPORTUNITY');
    const st = async (id: string) => one<Record<string, any>>(db(), 'SELECT website_status, website_status_basis FROM businesses WHERE id = $1', [id]);
    expect(await st(gone)).toEqual({ website_status: 'WEBSITE_UNREACHABLE', website_status_basis: 'OBSERVED' });
    expect(await st(slow)).toEqual({ website_status: 'WEBSITE_UNREACHABLE', website_status_basis: 'NOT_OBSERVABLE' });
    expect(await st(walled)).toEqual({ website_status: 'WEBSITE_UNREACHABLE', website_status_basis: 'NOT_OBSERVABLE' });
    const v = (await getRunBusinessAnalysis(db(), runId, slow))!;
    expect(v.observations).toEqual([expect.objectContaining({ checkCode: 'website_presence.fetch', state: 'NOT_OBSERVABLE' })]);
    expect(v.page).toMatchObject({ httpStatus: null, finalUrl: null, htmlSha256: null });
    const ev = await db().query('SELECT 1 FROM evidence WHERE business_id = ANY ($1)', [[gone, slow, walled]]);
    expect(ev.rows).toHaveLength(0);
  });

  it('reads a parked page as needing review, not as a website and not as "no website"', async () => {
    const { runId } = await seedRun(db());
    const b = await runBusiness(db(), runId, { domain: 'parked.test' });
    await analyse(new TableProbe({ 'https://parked.test/': { html: '<html><body><h1>parked.test</h1><p>This domain is for sale. Buy this domain today.</p></body></html>' } }), runId, b);
    expect(await one(db(), 'SELECT website_status, website_status_basis FROM businesses WHERE id = $1', [b]))
      .toEqual({ website_status: 'WEBSITE_NEEDS_REVIEW', website_status_basis: 'INFERRED' });
  });

  it('traces booking links once each: a 404 is a dead end, a script link and a 5xx are not observable', async () => {
    const { runId } = await seedRun(db());
    const b = await runBusiness(db(), runId, { domain: 'lanephysio.test' });
    const probe = new TableProbe({ 'https://lanephysio.test/': { html: BOOKING }, 'https://book.lanephysio.test/old': { status: 404 } });
    const r = await analyse(probe, runId, b);
    expect(probe.calls).toEqual([{ url: 'https://lanephysio.test/', body: true }, { url: 'https://book.lanephysio.test/old', body: false }]);
    const ev = await evidenceOf(r.analysisId);
    expect(ev.map((e) => [e.issue_code, e.confidence, `${e.rule_key}@${e.version}`])).toEqual([['E-CTA-DEAD-END', 'MEDIUM', 'check.booking_cta_trace@2']]);
    expect(ev[0].quote).toBe('<a href="https://book.lanephysio.test/old">Book an appointment</a>');
    expect(r.state).toBe('OPPORTUNITY_FOUND');
    const opp = await one<Record<string, any>>(db(), `SELECT o.opportunity_type, c.key FROM opportunities o JOIN catalog_items c ON c.id = o.catalog_item_id WHERE o.id = $1`, [r.opportunityIds[0]]);
    expect(opp).toEqual({ opportunity_type: 'dead_end_booking_link', key: 'website_fix_sprint' });
    const v = (await getRunBusinessAnalysis(db(), runId, b))!;
    const cta = v.observations.filter((o) => o.checkCode === 'booking_cta_trace.target');
    expect(cta.map((o) => o.state)).toEqual(['OBSERVED', 'NOT_OBSERVABLE']);
    expect(v.requests).toBe(2);

    const { runId: run2 } = await seedRun(db());
    const b2 = await runBusiness(db(), run2, { domain: 'lanephysio2.test' });
    const r2 = await analyse(new TableProbe({ 'https://lanephysio2.test/': { html: BOOKING.replaceAll('lanephysio', 'lanephysio2') },
      'https://book.lanephysio2.test/old': { status: 503 } }), run2, b2);
    expect(r2.state).toBe('NO_OPPORTUNITY');
  });

  it('recognises a self-booking platform as observed, never as a finding', async () => {
    const { runId } = await seedRun(db());
    const b = await runBusiness(db(), runId, { domain: 'oakdental.test' });
    const r = await analyse(new TableProbe({ 'https://oakdental.test/': { html: PLATFORM }, 'https://oakdental.setmore.com/': { status: 200 } }), runId, b);
    const v = (await getRunBusinessAnalysis(db(), runId, b))!;
    expect(v.observations.find((o) => o.checkCode === 'booking_platform_fingerprint.platform')).toMatchObject({ state: 'OBSERVED', result: 'ok', fact: 'The page uses Setmore for self-booking.' });
    expect(r.state).toBe('NO_OPPORTUNITY');
  });
});

describe('what analysis does not do', () => {
  it('records that no website address is known, requests nothing and leaves the website status unknown', async () => {
    const { runId } = await seedRun(db());
    const b = await runBusiness(db(), runId, { domain: null });
    const probe = new TableProbe();
    const r = await analyse(probe, runId, b);
    expect(probe.calls).toHaveLength(0);
    expect(r.state).toBe('NO_OPPORTUNITY');
    const v = (await getRunBusinessAnalysis(db(), runId, b))!;
    expect(v).toMatchObject({ outcome: 'NO_ADDRESS', requestedUrl: null, page: null, observations: [], requests: 0, website: { status: 'UNKNOWN' } });
    // B21: a provider record without a website is not "no website"; E-NO-WEBSITE stays out of reach.
    expect(await failure(db(), `UPDATE businesses SET website_status = 'WEBSITE_NOT_OBSERVED' WHERE id = $1`, [b])).toMatch(/website/);
  });

  it('never requests an address that is not on the public web', async () => {
    const { runId } = await seedRun(db());
    const b = await runBusiness(db(), runId, { domain: null, websiteUrl: 'http://localhost:8080/admin' });
    const probe = new TableProbe();
    await analyse(probe, runId, b);
    expect(probe.calls).toHaveLength(0);
    expect((await getRunBusinessAnalysis(db(), runId, b))!.outcome).toBe('REFUSED');
  });

  it('refuses a business nobody selected, and a run with a credit budget it has no rate for', async () => {
    const { runId } = await seedRun(db());
    const probe = new TableProbe({ 'https://q.test/': { html: CLINIC } });
    const qualified = await runBusiness(db(), runId, { domain: 'q.test' }, 'QUALIFIED');
    const rejected = await runBusiness(db(), runId, { domain: 'q.test2' }, 'REJECTED');
    expect(await refused(db(), () => analyse(probe, runId, qualified))).toBe('Only a business you selected for analysis can be analysed.');
    expect(await refused(db(), () => analyse(probe, runId, rejected))).toBe('Only a business you selected for analysis can be analysed.');
    expect(await refused(db(), () => analyse(probe, runId, '999999999'))).toBe('That business is not in this search run.');
    expect(await refused(db(), () => analyse(probe, runId, qualified, '  '))).toBe('Say who is asking for this analysis.');
    const budget = await seedRun(db(), { budget: 10 });
    const sel = await runBusiness(db(), budget.runId, { domain: 'q.test' });
    expect(await refused(db(), () => analyse(probe, budget.runId, sel))).toMatch(/no credit rate for analysis/);
    expect(probe.calls).toHaveLength(0);
    // And the database refuses an analysis record for a business that was not queued.
    expect(await failure(db(), `INSERT INTO business_analyses (search_run_id, business_id, analyzer, outcome, requested_url, requested_by, started_at, finished_at)
      VALUES ($1, $2, 'scopely.static/1', 'CHECKED', 'https://q.test/', 'x', now(), now())`, [runId, qualified])).toMatch(/only a selected business queued/);
    expect(AnalysisRefused).toBeDefined();
  });

  it('never changes an analysis record once written', async () => {
    const { runId, businessId, probe } = await clinic();
    const r = await analyse(probe, runId, businessId);
    expect(await failure(db(), `UPDATE business_analyses SET requested_by = 'Someone else' WHERE id = $1`, [r.analysisId])).toMatch(/never changes/);
    expect(await failure(db(), `UPDATE snapshots SET analysis_id = NULL WHERE analysis_id = $1`, [r.analysisId])).toMatch(/never changes/);
  });
});

describe('mapping findings to services', () => {
  it('opens nothing for findings no wanted service covers, and says so', async () => {
    const { runId, businessId, probe } = await clinic({ kinds: ['website'] });
    const r = await analyse(probe, runId, businessId);
    expect(r).toMatchObject({ state: 'NO_OPPORTUNITY', opportunityIds: [] });
    const v = (await getRunBusinessAnalysis(db(), runId, businessId))!;
    expect(v.findings).toHaveLength(4);
    expect(v.findings.every((f) => f.note === 'no_service' && f.opportunityId === null)).toBe(true);
  });

  it('uses the workspace’s own service over the shared starter with the same key', async () => {
    const own = await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, build_kind, supported_issue_codes)
      VALUES ('website_fix_sprint', 'Our link repair', 'Fix links', 'website_fix', ARRAY['E-WA-BROKEN','E-TEL-BROKEN','E-EMAIL-INVALID','E-LINK-TARGET-MISMATCH']) RETURNING id`);
    const { runId, businessId, probe } = await clinic();
    const r = await analyse(probe, runId, businessId);
    expect(await one(db(), 'SELECT catalog_item_id::text AS c FROM opportunities WHERE id = $1', [r.opportunityIds[0]])).toEqual({ c: own.id });
  });

  it('never opens the same finding twice across runs, but opens it again once the old one no longer holds', async () => {
    const first = await clinic();
    const a = await analyse(first.probe, first.runId, first.businessId);
    const { runId: run2 } = await seedRun(db());
    await db().query('INSERT INTO search_run_businesses (search_run_id, business_id) VALUES ($1, $2)', [run2, first.businessId]);
    await db().query(`UPDATE search_run_businesses SET state = 'QUALIFIED', qualification = '[]', qualified_at = $3,
        qualification_rule_version_id = (SELECT id FROM rule_versions WHERE rule_key = 'qualify.search_criteria') WHERE search_run_id = $1 AND business_id = $2`, [run2, first.businessId, AT]);
    await db().query(`UPDATE search_run_businesses SET state = 'SELECTED', selected_at = $3, selected_by = 'Seller' WHERE search_run_id = $1 AND business_id = $2`, [run2, first.businessId, AT]);
    const b = await analyse(first.probe, run2, first.businessId);
    expect(b).toMatchObject({ state: 'NO_OPPORTUNITY', opportunityIds: [] });
    const v = (await getRunBusinessAnalysis(db(), run2, first.businessId))!;
    expect(v.findings.every((f) => f.note === 'already_held' && f.opportunityId === a.opportunityIds[0])).toBe(true);

    // The seller re-checks the WhatsApp finding and it is gone: a new run finding it again opens it again.
    const wa = (await evidenceOf(a.analysisId)).find((e) => e.issue_code === 'E-WA-BROKEN')!;
    await recordCaseRecheck(db(), a.opportunityIds[0]!, String(wa.id), { result: 'gone', recordedBy: 'Seller' });
    const { runId: run3 } = await seedRun(db());
    await db().query('INSERT INTO search_run_businesses (search_run_id, business_id) VALUES ($1, $2)', [run3, first.businessId]);
    await db().query(`UPDATE search_run_businesses SET state = 'QUALIFIED', qualification = '[]', qualified_at = $3,
        qualification_rule_version_id = (SELECT id FROM rule_versions WHERE rule_key = 'qualify.search_criteria') WHERE search_run_id = $1 AND business_id = $2`, [run3, first.businessId, AT]);
    await db().query(`UPDATE search_run_businesses SET state = 'SELECTED', selected_at = $3, selected_by = 'Seller' WHERE search_run_id = $1 AND business_id = $2`, [run3, first.businessId, AT]);
    const c = await analyse(first.probe, run3, first.businessId);
    expect(c.state).toBe('OPPORTUNITY_FOUND');
    const codes = (await db().query(`SELECT e.issue_code FROM opportunity_evidence oe JOIN evidence e ON e.id = oe.evidence_id WHERE oe.opportunity_id = $1`, [c.opportunityIds[0]])).rows;
    expect(codes).toEqual([{ issue_code: 'E-WA-BROKEN' }]);
  });

  it('is idempotent: analysing again returns the first result without a second request', async () => {
    const { runId, businessId, probe } = await clinic();
    const a = await analyse(probe, runId, businessId);
    const b = await analyse(probe, runId, businessId);
    expect(b).toEqual({ ...a, analysedNow: false });
    expect(probe.calls).toHaveLength(1);
    expect((await db().query('SELECT 1 FROM snapshots WHERE business_id = $1', [businessId])).rows).toHaveLength(1);
    expect((await db().query('SELECT 1 FROM opportunities WHERE business_id = $1', [businessId])).rows).toHaveLength(1);
  });
});

describe('the opportunity in the existing gates', () => {
  it('opens in the Case File, needs a re-check before anything reaches the prospect, and the Fix Builder can capture it', async () => {
    const { runId, businessId, probe } = await clinic();
    const r = await analyse(probe, runId, businessId);
    const oppId = r.opportunityIds[0]!;
    const cf = (await getCaseFile(db(), oppId))!;
    expect(cf).toMatchObject({ path: 'FIX', kind: 'website_fix', service: { mappingStatus: 'MAPPED', catalogKey: 'website_fix_sprint' } });
    expect(cf.evidence).toHaveLength(4);
    expect(cf.build).toMatchObject({ builder: 'fix', canStart: true, blocker: null });
    expect(cf.outreach.recheckNeeded).toHaveLength(4);
    expect(cf.readiness.status).toBe('NOT_READY');
    expect(cf.business.sources).toEqual([]);
    // The send/show gate refuses the unchecked HIGH findings exactly as for hand-recorded ones.
    const ids = cf.evidence.map((e) => e.evidenceId);
    expect((await one<{ b: string | null }>(db(), 'SELECT scopely.evidence_send_blocker($1::bigint[], now()) AS b', [ids])).b).toMatch(/no confirmed re-check/);

    // A person's re-check on the automated finding passes the existing re-check guard.
    const wa = cf.evidence.find((e) => e.issueCode === 'E-WA-BROKEN')!;
    await recordCaseRecheck(db(), oppId, wa.evidenceId, { result: 'confirmed', recordedBy: 'Seller' });
    expect((await getCaseFile(db(), oppId))!.outreach.recheckNeeded).toHaveLength(3);

    // The Fix Builder captures the evidence's own page and finds the link exactly as it was quoted.
    const projectId = await openFixProject(db(), oppId);
    const fetcher = new StubFetcher(CLINIC);
    const cap = await captureFixPage(db(), { store: new MemoryObjectStore(), fetcher }, projectId, { evidenceId: wa.evidenceId });
    expect(fetcher.calls).toEqual(['https://harbourclinic.test/']);
    expect(cap).toMatchObject({ hrefOccurrences: 1, label: 'WhatsApp us' });
  });

  it('shows each analysed business on the run with its opportunities', async () => {
    const { runId, businessId, probe } = await clinic();
    const r = await analyse(probe, runId, businessId);
    const view = (await getRunDiscovery(db(), runId))!;
    expect(view.businesses.find((b) => b.businessId === businessId)!.analysis).toEqual({ analysisId: r.analysisId, outcome: 'CHECKED', findings: 4, opportunityIds: r.opportunityIds });
  });
});

describe('workspace isolation', () => {
  it('cannot analyse, read or attach to another workspace’s run, business or analysis', async () => {
    const mine = await clinic();
    const a = await analyse(mine.probe, mine.runId, mine.businessId);
    const wsA = await currentWs();
    const wsB = await enterNewWorkspace(db(), 'other');
    expect(await refused(db(), () => analyse(mine.probe, mine.runId, mine.businessId))).toBe('That business is not in this search run.');
    expect(await getRunBusinessAnalysis(db(), mine.runId, mine.businessId)).toBeNull();
    // Row-level security: as the application role, workspace B sees none of A's analysis rows.
    const seen = await asApp(db(), wsB, async () => (await db().query('SELECT count(*)::int AS n FROM business_analyses')).rows[0].n);
    expect(seen).toBe(0);
    const seenA = await asApp(db(), wsA, async () => (await db().query('SELECT count(*)::int AS n FROM business_analyses')).rows[0].n);
    expect(seenA).toBe(1);
    // A snapshot of B's business cannot point at A's analysis.
    const theirs = await one<{ id: string }>(db(), `INSERT INTO businesses (name) VALUES ('B business') RETURNING id`);
    expect(await failure(db(), `INSERT INTO snapshots (business_id, analysis_id, url, fetched_at, fetch_method) VALUES ($1, $2, 'https://x.test/', now(), 'http')`,
      [theirs.id, a.analysisId])).toMatch(/WORKSPACE|ANALYSIS/);
    await useWorkspace(db(), wsA);
    // Nor can A's own snapshot of another business claim this analysis.
    const other = await one<{ id: string }>(db(), `INSERT INTO businesses (name) VALUES ('Another A business') RETURNING id`);
    expect(await failure(db(), `INSERT INTO snapshots (business_id, analysis_id, url, fetched_at, fetch_method) VALUES ($1, $2, 'https://x.test/', now(), 'http')`,
      [other.id, a.analysisId])).toMatch(/cannot belong to the analysis/);
  });
});

describe('the live probe’s guard', () => {
  it('reads a name that does not exist as not found, and a failed lookup as nothing observed', async () => {
    const failing = (code: string) => new SafeProbe(async () => { throw Object.assign(new Error('lookup'), { code }); }, now);
    expect(await failing('ENOTFOUND').get('https://gone.test/')).toMatchObject({ kind: 'error', error: 'dns_not_found' });
    for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', '']) {
      const r = await failing(code).get('https://flaky.test/');
      expect(r, code).toMatchObject({ kind: 'error', error: 'other' });
    }
    // So the website status is unreachable on a NOT_OBSERVABLE basis, not an OBSERVED one.
    expect(classifyWebsiteFetch({ kind: 'error', error: 'other' })).toEqual({ status: 'WEBSITE_UNREACHABLE', basis: 'NOT_OBSERVABLE' });
    expect(classifyWebsiteFetch({ kind: 'error', error: 'dns_not_found' })).toEqual({ status: 'WEBSITE_UNREACHABLE', basis: 'OBSERVED' });
  });

  it('refuses private, loopback and odd addresses before connecting, and never throws for them', async () => {
    const probe = (addrs: string[]) => new SafeProbe(async () => addrs, now);
    expect(await probe(['10.0.0.5']).get('https://intranet.test/')).toMatchObject({ kind: 'error', error: 'blocked' });
    expect(await probe(['93.184.216.34', '127.0.0.1']).get('https://mixed.test/')).toMatchObject({ kind: 'error', error: 'blocked' });
    expect(await probe([]).get('https://nowhere.test/')).toMatchObject({ kind: 'error', error: 'dns_not_found' });
    for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'https://169.254.169.254/latest/meta-data', 'ftp://files.test/',
      'https://user:pw@site.test/', 'https://site.test:8443/', 'http://printer.local/', 'file:///etc/passwd']) {
      expect(await probe(['93.184.216.34']).get(url)).toMatchObject({ kind: 'error', error: 'blocked' });
    }
  });
});
