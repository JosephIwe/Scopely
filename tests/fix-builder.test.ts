// Slice 7: the Fix Builder for a broken contact link. OBSERVED PROBLEM → EVIDENCE → CAPTURE →
// PROPOSED FIX → GENERATE → BEFORE / AFTER → HUMAN CONFIRMATION → PREVIEW → SHOW, on the Slice 4
// to 6 primitives, with every gate of the website path kept and one added (F4).
import { describe, expect, it } from 'vitest';
import {
  FIX_AGENT_KEY, captureFixPage, confirmFix, describeHref, fixRunDeps, generateFix, getFixWorkspace, isBlockedAddress,
  assertCapturableUrl, openFixProject, proposeCorrection, readFixPage, replaceLinks, SafePageFetcher, showFixVersion, toHref,
} from '../src/build/fix/index.js';
import { approveBuild, executeBuildRun, markBuildShown, queueBuildRun, withAgentActor } from '../src/build/index.js';
import {
  approveVersion, listProspectLinks, loadPreviewArtifact, openWebsiteProject, previewLink, revokeProspectLink, verifyPreview,
} from '../src/build/site/index.js';
import { sha256 } from '../src/storage/index.js';
import { asApp, catalogId, enterNewWorkspace, failure, one, refused, useDb, useWorkspace } from './helpers.js';
import { PAGE, StubFetcher, addEvidence, recheckChanged, seedFixOpportunity } from './fix-helpers.js';
import { SIGNING_KEY, confirmRecheck, newStore, seedWebsiteOpportunity } from './site-helpers.js';

const { db } = useDb();

const WS = async () => (await one<{ ws: string }>(db(), 'SELECT scopely.current_workspace_id()::text AS ws')).ws;

/** An opened fix project with its page captured. */
async function captured(opts: { page?: string | null } = {}) {
  const seed = await seedFixOpportunity(db());
  const store = newStore();
  const fetcher = new StubFetcher(opts.page === undefined ? PAGE : opts.page);
  const projectId = await openFixProject(db(), seed.opportunityId);
  const capture = await captureFixPage(db(), { store, fetcher }, projectId, { evidenceId: seed.evidenceId });
  return { seed, store, fetcher, projectId, capture };
}

/** A generated fix version with a proposed (unconfirmed) WhatsApp destination. */
async function generated() {
  const c = await captured();
  const correction = await proposeCorrection(db(), c.projectId, { evidenceId: c.seed.evidenceId, channel: 'whatsapp', value: '+44 7700 900123' });
  const run = await generateFix(db(), { store: c.store }, c.projectId);
  expect(run.status).toBe('SUCCEEDED');
  return { ...c, correction, buildId: String(run.buildId) };
}

const CORRECTED = 'https://wa.me/447700900123';
const AT = '2026-10-02T09:00:00Z';

// ================================================================== 1. a valid broken-contact-link finding

describe('the Fix Builder starts from a VALIDATED broken-contact-link finding', () => {
  it('opens one fix project for a website_fix opportunity and reuses it', async () => {
    const seed = await seedFixOpportunity(db());
    const p = await openFixProject(db(), seed.opportunityId);
    expect(await openFixProject(db(), seed.opportunityId)).toBe(p);
    const w = await getFixWorkspace(db(), newStore(), p);
    expect(w.focus).toMatchObject({ evidenceId: String(seed.evidenceId), issueCode: 'E-LINK-TARGET-MISMATCH', supported: true,
      observedHref: 'tel:WhatsApp:0800', channels: ['phone', 'whatsapp', 'email'], confidence: 'HIGH', claimState: 'OBSERVED' });
    expect(w.capture).toBeNull();
    expect(w.current).toBeNull();
    expect(w.steps).toMatchObject({ problem: 'done', proof: 'done', capture: 'current', fix: 'todo', confirm: 'todo', show: 'todo' });
  });

  it('supports exactly the VALIDATED codes of the contact-link check (F1)', async () => {
    const r = await db().query(`SELECT code FROM issue_codes WHERE scopely.fix_supported_issue_code(code) ORDER BY code`);
    expect(r.rows.map((x) => x.code)).toEqual(['E-EMAIL-INVALID', 'E-LINK-TARGET-MISMATCH', 'E-TEL-BROKEN', 'E-WA-BROKEN']);
  });

  it('refuses an opportunity that is not a website fix, or has no supported finding that holds', async () => {
    const site = await seedWebsiteOpportunity(db());
    expect(await refused(db(), () => openFixProject(db(), site.opportunityId))).toMatch(/not mapped to a website fix service/);
    const seed = await seedFixOpportunity(db());
    // A HYPOTHESIS finding (placeholder links) is not one the Fix Builder repairs.
    const other = await seedFixOpportunity(db());
    const placeholder = await addEvidence(db(), other, other.opportunityId, { code: 'E-PLACEHOLDER-LINK', rule: await ruleOf('check.placeholder_links') });
    await db().query('DELETE FROM opportunity_evidence WHERE opportunity_id = $1 AND evidence_id <> $2', [other.opportunityId, placeholder]);
    expect(await refused(db(), () => openFixProject(db(), other.opportunityId))).toMatch(/no observed broken contact link/);
    expect(await refused(db(), () => openWebsiteProject(db(), other.opportunityId))).toMatch(/not mapped to a website service/);
  });

  it('refuses a finding whose re-check found it changed or gone', async () => {
    const seed = await seedFixOpportunity(db());
    await recheckChanged(db(), seed.businessId, seed.evidenceId);
    expect(await refused(db(), () => openFixProject(db(), seed.opportunityId))).toMatch(/no observed broken contact link that still holds/);
  });
});

async function ruleOf(key: string) {
  return (await one<{ id: string }>(db(), 'SELECT id FROM rule_versions WHERE rule_key = $1 AND version = 1', [key])).id;
}

// ================================================================== 3. capture

describe('capture: a faithful copy of the observed page, as proof material', () => {
  it('stores the page byte for byte under the project\'s captures/ prefix with its hash, and counts the broken links on it', async () => {
    const { seed, store, fetcher, projectId, capture } = await captured();
    expect(fetcher.calls).toEqual(['https://example-clinic.test/']);
    const row = await one<Record<string, any>>(db(), 'SELECT * FROM fix_captures WHERE id = $1', [capture.captureId]);
    expect(row.storage_ref).toMatch(new RegExp(`^workspaces/${await WS()}/projects/${projectId}/captures/[0-9a-f-]+\\.html$`));
    const stored = store.objects.get(row.storage_ref)!;
    expect(stored.bytes.equals(Buffer.from(PAGE, 'utf8'))).toBe(true);
    expect(row.sha256).toBe(sha256(Buffer.from(PAGE, 'utf8')));
    expect(row).toMatchObject({ observed_href: 'tel:WhatsApp:0800', href_occurrences: 2, http_status: 200, evidence_id: String(seed.evidenceId) });
    expect(capture).toMatchObject({ hrefOccurrences: 2, label: 'WhatsApp: 0800' });
    expect(capture.context!.before).toMatch(/Book a consultation/);
    // One metered fetch, with no invented price.
    const cost = await one<Record<string, any>>(db(), `SELECT kind, amount, currency, meta FROM cost_events WHERE opportunity_id = $1`, [seed.opportunityId]);
    expect(cost).toMatchObject({ kind: 'fetch', amount: null, currency: null });
    expect(cost.meta).toEqual({ purpose: 'fix_capture', captureId: capture.captureId });
    const w = await getFixWorkspace(db(), store, projectId);
    expect(w.steps).toMatchObject({ capture: 'done', fix: 'current' });
  });

  it('records nothing when the page cannot be fetched', async () => {
    const seed = await seedFixOpportunity(db());
    const store = newStore();
    const projectId = await openFixProject(db(), seed.opportunityId);
    const err = await refused(db(), () => captureFixPage(db(), { store, fetcher: new StubFetcher(null) }, projectId, { evidenceId: seed.evidenceId }));
    expect(err).toMatch(/could not capture the page.*Nothing was recorded/);
    expect((await db().query('SELECT 1 FROM fix_captures')).rows).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  it('records a page that no longer shows the link, and refuses to correct it', async () => {
    const { seed, projectId, capture } = await captured({ page: '<html><body><a href="tel:+442079460000">Call</a></body></html>' });
    expect(capture.hrefOccurrences).toBe(0);
    expect(await refused(db(), () => proposeCorrection(db(), projectId, { evidenceId: seed.evidenceId, channel: 'whatsapp', value: '447700900123' })))
      .toMatch(/no longer shows the broken link/);
  });

  it('refuses a capture that changes, names another destination, sits outside captures/, or is made by an agent', async () => {
    const { seed, projectId, capture } = await captured();
    expect(await failure(db(), `UPDATE fix_captures SET href_occurrences = 5 WHERE id = $1`, [capture.captureId])).toMatch(/proof material and never changes/);
    const ws = await WS();
    const ins = (href: string, ref: string) => failure(db(), `INSERT INTO fix_captures (project_id, evidence_id, requested_url, final_url, http_status, content_type,
      storage_ref, sha256, byte_size, observed_href, href_occurrences, captured_by)
      VALUES ($1, $2, 'https://e.test/', 'https://e.test/', 200, 'text/html', $3, repeat('a', 64), 10, $4, 1, 'op')`, [projectId, seed.evidenceId, ref, href]);
    expect(await ins('tel:+440000000', `workspaces/${ws}/projects/${projectId}/captures/x.html`)).toMatch(/records the destination that was observed/);
    expect(await ins('tel:WhatsApp:0800', `workspaces/${ws}/projects/${projectId}/versions/x.html`)).toMatch(/outside this project's storage/);
    expect(await ins('tel:WhatsApp:0800', `workspaces/${ws}/projects/${projectId}/captures/ok.html`)).toBeNull();
    await withAgentActor(db(), async () => {
      expect(await ins('tel:WhatsApp:0800', `workspaces/${ws}/projects/${projectId}/captures/agent.html`)).toMatch(/build agent cannot record a page capture/);
    });
  });

  it('captures only a supported, OBSERVED finding of a website_fix project', async () => {
    const seed = await seedFixOpportunity(db());
    const projectId = await openFixProject(db(), seed.opportunityId);
    const ws = await WS();
    const ins = (evidenceId: string, project = projectId) => failure(db(), `INSERT INTO fix_captures (project_id, evidence_id, requested_url, final_url, http_status,
      content_type, storage_ref, sha256, byte_size, observed_href, href_occurrences, captured_by)
      SELECT $1, $2, 'https://e.test/', 'https://e.test/', 200, 'text/html', $3, repeat('a', 64), 10, o.href, 1, 'op'
        FROM evidence e JOIN observations o ON o.id = e.observation_id WHERE e.id = $2`, [project, evidenceId, `workspaces/${ws}/projects/${project}/captures/c.html`]);
    const placeholder = await addEvidence(db(), seed, seed.opportunityId, { code: 'E-PLACEHOLDER-LINK', rule: await ruleOf('check.placeholder_links') });
    expect(await ins(placeholder)).toMatch(/not a finding the Fix Builder repairs/);
    const site = await seedWebsiteOpportunity(db());
    const siteProject = await openWebsiteProject(db(), site.opportunityId);
    expect(await ins(site.evidenceId, siteProject)).toMatch(/only a website_fix project captures a page/);
    const stranger = await seedFixOpportunity(db());
    expect(await ins(stranger.evidenceId)).toMatch(/not part of the project's opportunity/);
    const tel = await addEvidence(db(), seed, seed.opportunityId, { code: 'E-TEL-BROKEN' });
    expect(await ins(tel)).toBeNull();
    await recheckChanged(db(), seed.businessId, tel);
    expect(await ins(tel)).toMatch(/no longer holds/);
  });
});

// ================================================================== 4, 5. the proposed correction

describe('the corrected destination is typed by a person and checked for shape only', () => {
  it('writes each kind of destination as its link, without guessing a country code', () => {
    expect(toHref('phone', '+44 (20) 7946-0000')).toBe('tel:+442079460000');
    expect(toHref('phone', '0044 20 7946 0000')).toBe('tel:+442079460000');
    expect(() => toHref('phone', '020 7946 0000')).toThrow(/country code/);
    expect(toHref('whatsapp', '+44 7700 900123')).toBe(CORRECTED);
    expect(toHref('whatsapp', 'https://wa.me/447700900123')).toBe(CORRECTED);
    expect(() => toHref('whatsapp', '07700900123')).toThrow(/country code/);
    expect(toHref('email', 'hello@clinic.example.co.uk')).toBe('mailto:hello@clinic.example.co.uk');
    expect(() => toHref('email', 'javascript:alert(1)')).toThrow(/not an email/);
    expect(() => toHref('email', '')).toThrow(/Type the destination/);
    expect(describeHref(CORRECTED)).toBe('Opens WhatsApp to +447700900123');
  });

  it('records a proposal unconfirmed against the latest capture; the same value is kept, a new one withdraws it', async () => {
    const { seed, projectId, capture } = await captured();
    const a = await proposeCorrection(db(), projectId, { evidenceId: seed.evidenceId, channel: 'whatsapp', value: '447700900123' });
    expect(a).toMatchObject({ correctedHref: CORRECTED, captureId: capture.captureId, confirmedAt: null, channel: 'whatsapp' });
    const same = await proposeCorrection(db(), projectId, { evidenceId: seed.evidenceId, channel: 'whatsapp', value: '+447700900123' });
    expect(same.correctionId).toBe(a.correctionId);
    const b = await proposeCorrection(db(), projectId, { evidenceId: seed.evidenceId, channel: 'phone', value: '+44 20 7946 0001' });
    expect(b.correctedHref).toBe('tel:+442079460001');
    const rows = (await db().query('SELECT id, withdrawn_at FROM fix_corrections WHERE project_id = $1 ORDER BY id', [projectId])).rows;
    expect(rows.map((r) => r.withdrawn_at !== null)).toEqual([true, false]);
    const w = await getFixWorkspace(db(), newStore(), projectId);
    expect(w.correction!.correctionId).toBe(b.correctionId);
  });

  it('refuses a destination of the wrong kind for the finding, the broken one again, or one typed before a capture', async () => {
    const seed = await seedFixOpportunity(db());
    const projectId = await openFixProject(db(), seed.opportunityId);
    expect(await refused(db(), () => proposeCorrection(db(), projectId, { evidenceId: seed.evidenceId, channel: 'whatsapp', value: '447700900123' })))
      .toMatch(/Capture the page first/);
    const tel = await addEvidence(db(), seed, seed.opportunityId, { code: 'E-TEL-BROKEN' });
    expect(await refused(db(), () => proposeCorrection(db(), projectId, { evidenceId: tel, channel: 'email', value: 'a@b.example' })))
      .toMatch(/repaired with a phone number/);
    expect(await refused(db(), () => proposeCorrection(db(), projectId, { evidenceId: tel, channel: 'phone', value: '07700' })))
      .toMatch(/country code/);
  });

  it('5. makes nothing without a corrected destination', async () => {
    const { projectId, store } = await captured();
    expect(await refused(db(), () => generateFix(db(), { store }, projectId))).toMatch(/Type the corrected destination first/);
    expect((await db().query('SELECT 1 FROM builds WHERE project_id = $1', [projectId])).rows).toEqual([]);
  });
});

// ================================================================== 8, 9. BEFORE and AFTER

describe('BEFORE stays as captured; AFTER differs only by the corrected destination', () => {
  it('generates a DRAFT version through a build run with no model, citing the evidence and the correction', async () => {
    const { projectId, buildId, correction, seed } = await generated();
    const b = await one<Record<string, any>>(db(), 'SELECT * FROM builds WHERE id = $1', [buildId]);
    expect(b).toMatchObject({ status: 'DRAFT', build_kind: 'website_fix', purpose: 'DEMO', generator: `agent:${FIX_AGENT_KEY}:1`, version_no: 1, approved_at: null });
    expect(b.summary).toContain(`tel:WhatsApp:0800 → ${CORRECTED}`);
    const run = await one<Record<string, any>>(db(), 'SELECT * FROM build_runs WHERE produced_build_id = $1', [buildId]);
    expect(run).toMatchObject({ agent_key: FIX_AGENT_KEY, status: 'SUCCEEDED', provider_connection_id: null });
    expect((await db().query('SELECT 1 FROM cost_events WHERE build_run_id = $1', [run.id])).rows).toEqual([]);
    expect((await db().query('SELECT evidence_id FROM build_evidence WHERE build_id = $1', [buildId])).rows.map((r) => String(r.evidence_id))).toEqual([String(seed.evidenceId)]);
    expect((await db().query('SELECT correction_id FROM build_fix_corrections WHERE build_id = $1', [buildId])).rows.map((r) => String(r.correction_id)))
      .toEqual([correction.correctionId]);
    const w = await getFixWorkspace(db(), newStore(), projectId).catch(() => null);
    void w;
  });

  it('keeps the captured page byte for byte and corrects only the matching links, never a script or comment', async () => {
    const { store, projectId, buildId, capture } = await generated();
    const cap = await one<Record<string, any>>(db(), 'SELECT * FROM fix_captures WHERE id = $1', [capture.captureId]);
    const before = await readFixPage(db(), store, projectId, buildId, 'before');
    const after = await readFixPage(db(), store, projectId, buildId, 'after');
    expect(before!.equals(Buffer.from(PAGE, 'utf8'))).toBe(true);
    expect(sha256(store.objects.get(cap.storage_ref)!.bytes)).toBe(cap.sha256);
    const a = after!.toString('utf8');
    expect(a).toContain(`<a class="wa" href="${CORRECTED}">WhatsApp: 0800</a>`);
    expect(a).toContain(`<a href='${CORRECTED}'>Chat on WhatsApp</a>`);
    expect(a).toContain(`var tpl = '<a href="tel:WhatsApp:0800">x</a>';`);
    expect(a).toContain('<!-- old: <a href="tel:WhatsApp:0800">old</a> -->');
    expect(a).toContain('Café &amp; clinic');
    // Put the two corrected values back and the AFTER is the BEFORE, byte for byte.
    const back = a.replace(`href="${CORRECTED}"`, 'href="tel:WhatsApp:0800"').replace(`href='${CORRECTED}'`, "href='tel:WhatsApp:0800'");
    expect(Buffer.from(back, 'utf8').equals(before!)).toBe(true);
  });

  it('replaces only exact destinations in <a> tags, keeping quote style and every other byte', () => {
    const html = `<a href=tel:X>1</a><a href="tel:X ">2</a><a href="tel:X2">3</a><link href="tel:X"><a data-href="tel:X" href="tel:X">4</a><A HREF="tel:&#88;">5</A>`;
    const out = replaceLinks(html, 'tel:X', 'tel:+441234567');
    expect(out.replaced).toBe(4);
    expect(out.html).toBe(`<a href="tel:+441234567">1</a><a href="tel:+441234567">2</a><a href="tel:X2">3</a><link href="tel:X"><a data-href="tel:X" href="tel:+441234567">4</a><A HREF="tel:+441234567">5</A>`);
  });

  it('never changes a capture or the files of a version once written', async () => {
    const { store, projectId, buildId } = await generated();
    const keys = [...store.objects.keys()];
    const snapshot = new Map(keys.map((k) => [k, sha256(store.objects.get(k)!.bytes)]));
    await proposeCorrection(db(), projectId, { evidenceId: (await one<{ id: string }>(db(), 'SELECT evidence_id AS id FROM fix_captures LIMIT 1')).id,
      channel: 'phone', value: '+442079460001' });
    const next = await generateFix(db(), { store }, projectId);
    expect(next.status).toBe('SUCCEEDED');
    for (const [k, h] of snapshot) expect(sha256(store.objects.get(k)!.bytes), k).toBe(h);
    expect((await one<{ s: string }>(db(), 'SELECT status AS s FROM builds WHERE id = $1', [buildId])).s).toBe('SUPERSEDED');
    const v2 = await one<Record<string, any>>(db(), 'SELECT * FROM builds WHERE id = $1', [next.buildId]);
    expect(v2).toMatchObject({ version_no: 2, supersedes_build_id: buildId });
  });
});

// ================================================================== 10. nothing invents a correction

describe('an unsupported correction cannot be invented', () => {
  it('refuses a corrected value from an agent, of the wrong kind or shape, or already confirmed', async () => {
    const { seed, projectId, capture } = await captured();
    const ins = (channel: string, href: string, extra = '') => failure(db(), `INSERT INTO fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by${extra ? ', confirmed_by, confirmed_at' : ''})
      VALUES ($1, $2, $3, $4, $5, 'seller'${extra})`, [projectId, seed.evidenceId, capture.captureId, channel, href]);
    await withAgentActor(db(), async () => {
      expect(await ins('whatsapp', CORRECTED)).toMatch(/build agent cannot supply or confirm a corrected value/);
    });
    for (const bad of ['javascript:alert(1)', 'https://evil.example/', 'https://wa.me/07700900123', 'tel:+44 20']) {
      expect(await ins('whatsapp', bad), bad).toMatch(/fix_corrections_check|check constraint/);
    }
    expect(await ins('phone', 'tel:WhatsApp:0800')).toMatch(/check constraint|the corrected destination is the broken one/);
    expect(await ins('phone', 'tel:+442079460000', `, 'seller', now()`)).toMatch(/starts unconfirmed/);
    const tel = await addEvidence(db(), seed, seed.opportunityId, { code: 'E-TEL-BROKEN' });
    const telCap = await captureFixPage(db(), { store: newStore(), fetcher: new StubFetcher('<a href="tel:0800BROKEN">Call</a>') }, projectId, { evidenceId: tel });
    expect(await failure(db(), `INSERT INTO fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by)
      VALUES ($1, $2, $3, 'email', 'mailto:a@b.example', 'seller')`, [projectId, tel, telCap.captureId])).toMatch(/email destination does not repair E-TEL-BROKEN/);
    expect(await failure(db(), `INSERT INTO fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by)
      VALUES ($1, $2, $3, 'phone', 'tel:+442079460000', 'seller')`, [projectId, seed.evidenceId, telCap.captureId])).toMatch(/not a capture of this project's evidence/);
    expect(await ins('phone', 'tel:+442079460000')).toBeNull();
  });

  it('refuses to change, re-confirm, revive or confirm a withdrawn corrected value', async () => {
    const { projectId, correction } = await generated();
    const id = correction.correctionId;
    expect(await failure(db(), `UPDATE fix_corrections SET corrected_href = 'https://wa.me/447700900999' WHERE id = $1`, [id])).toMatch(/never changes/);
    await withAgentActor(db(), async () => {
      expect(await failure(db(), `UPDATE fix_corrections SET confirmed_by = 'agent', confirmed_at = now() WHERE id = $1`, [id])).toMatch(/build agent cannot/);
    });
    await db().query(`UPDATE fix_corrections SET confirmed_by = 'Sam', confirmed_at = now() WHERE id = $1`, [id]);
    expect(await failure(db(), `UPDATE fix_corrections SET confirmed_by = 'Other' WHERE id = $1`, [id])).toMatch(/confirmation stands/);
    expect(await failure(db(), `UPDATE fix_corrections SET confirmed_by = NULL, confirmed_at = NULL WHERE id = $1`, [id])).toMatch(/confirmation stands/);
    await db().query(`UPDATE fix_corrections SET withdrawn_at = now() WHERE id = $1`, [id]);
    expect(await failure(db(), `UPDATE fix_corrections SET withdrawn_at = NULL WHERE id = $1`, [id])).toMatch(/stays withdrawn/);
    const other = await proposeCorrection(db(), projectId, { evidenceId: correction.evidenceId, channel: 'phone', value: '+442079460001' });
    await db().query(`UPDATE fix_corrections SET withdrawn_at = now() WHERE id = $1`, [other.correctionId]);
    expect(await failure(db(), `UPDATE fix_corrections SET confirmed_by = 'Sam', confirmed_at = now() WHERE id = $1`, [other.correctionId])).toMatch(/withdrawn corrected value cannot be confirmed/);
    expect(await failure(db(), `INSERT INTO fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by)
      SELECT project_id, evidence_id, capture_id, channel, 'tel:+442079460055', 'seller' FROM fix_corrections WHERE id = $1`, [other.correctionId])).toBeNull();
    expect(await failure(db(), `INSERT INTO fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by)
      SELECT project_id, evidence_id, capture_id, channel, 'tel:+442079460056', 'seller' FROM fix_corrections WHERE id = $1`, [other.correctionId]))
      .toMatch(/fix_corrections_active_idx/);
  });

  it('a fix run refuses a correction that answers no evidence in its context, or a capture that is not its own', async () => {
    const { store, projectId, capture, seed } = await captured();
    const cap = await one<Record<string, any>>(db(), 'SELECT * FROM fix_captures WHERE id = $1', [capture.captureId]);
    const run = async (meta: Record<string, unknown>) => {
      const id = await queueBuildRun(db(), { projectId, purpose: 'DEMO', agentKey: FIX_AGENT_KEY, meta });
      return executeBuildRun(db(), fixRunDeps(store), id);
    };
    const capMeta = { captureId: capture.captureId, ref: cap.storage_ref, sha256: cap.sha256, contentType: cap.content_type, finalUrl: cap.final_url, capturedAt: '2026-09-28T10:00:00Z' };
    const good = { correctionId: '1', evidenceId: String(seed.evidenceId), channel: 'whatsapp', observedHref: 'tel:WhatsApp:0800', correctedHref: CORRECTED };
    const stranger = await seedFixOpportunity(db());
    expect(await run({ capture: capMeta, corrections: [{ ...good, evidenceId: String(stranger.evidenceId) }] })).toMatchObject({ status: 'FAILED', errorCode: 'CORRECTION_UNSUPPORTED' });
    expect(await run({ capture: capMeta, corrections: [{ ...good, correctedHref: 'javascript:alert(1)' }] })).toMatchObject({ status: 'FAILED', errorCode: 'CORRECTION_UNSUPPORTED' });
    expect(await run({ capture: capMeta, corrections: [{ ...good, observedHref: 'tel:NOT-ON-PAGE' }] })).toMatchObject({ status: 'FAILED', errorCode: 'LINK_NOT_ON_PAGE' });
    expect(await run({ capture: { ...capMeta, sha256: 'b'.repeat(64) }, corrections: [good] })).toMatchObject({ status: 'FAILED', errorCode: 'CAPTURE_UNVERIFIED' });
    expect(await run({ capture: capMeta, corrections: [] })).toMatchObject({ status: 'FAILED', errorCode: 'NO_CORRECTION' });
    // What the failed runs wrote is gone.
    expect([...store.objects.keys()].filter((k) => k.includes('/versions/'))).toEqual([]);
  });
});

// ================================================================== 6, 7, 11, 12. confirmation, approval and show

describe('a person confirms the corrected value before anything can be approved or shown (F4)', () => {
  it('6. an unconfirmed fix cannot be approved or shown by any path', async () => {
    const { projectId, buildId, store } = await generated();
    const w = await getFixWorkspace(db(), store, projectId);
    expect(w.current).toMatchObject({ status: 'DRAFT', confirmed: false, approveBlocker: 'Confirm the corrected destination first.' });
    expect(w.steps).toMatchObject({ beforeAfter: 'done', confirm: 'current', show: 'todo' });
    expect(await refused(db(), () => approveBuild(db(), buildId, 'Sam', AT))).toMatch(/FIX: this fix version needs a person to confirm the corrected value/);
    expect(await refused(db(), () => approveVersion(db(), projectId, buildId, { approvedBy: 'Sam' }))).toMatch(/not a website/);
    expect(await refused(db(), () => showFixVersion(db(), projectId, buildId, { at: AT }))).toMatch(/Confirm the corrected destination first/);
    expect(await refused(db(), () => confirmFix(db(), projectId, buildId, { confirmedBy: 'Sam', confirmed: false }))).toMatch(/Tick the box/);
    expect(await refused(db(), () => confirmFix(db(), projectId, buildId, { confirmedBy: '  ', confirmed: true }))).toMatch(/who is confirming/);
    expect((await one<{ s: string }>(db(), 'SELECT status AS s FROM builds WHERE id = $1', [buildId])).s).toBe('DRAFT');
  });

  it('7. a confirmed fix is approved, and once its finding is re-checked it is shown with a prospect link', async () => {
    const { projectId, buildId, store, seed, correction } = await generated();
    await confirmFix(db(), projectId, buildId, { confirmedBy: 'Sam', confirmed: true, at: AT });
    const c = await one<Record<string, any>>(db(), 'SELECT * FROM fix_corrections WHERE id = $1', [correction.correctionId]);
    expect(c.confirmed_by).toBe('Sam');
    expect((await one<Record<string, any>>(db(), 'SELECT status, approved_by FROM builds WHERE id = $1', [buildId]))).toMatchObject({ status: 'APPROVED', approved_by: 'Sam' });
    // 12. HIGH evidence still needs its re-check before the prospect sees anything.
    expect(await refused(db(), () => showFixVersion(db(), projectId, buildId, { at: AT }))).toMatch(/must be re-checked/);
    await confirmRecheck(db(), seed, '2026-10-01T09:00:00Z');
    await showFixVersion(db(), projectId, buildId, { at: AT });
    const link = await previewLink(db(), projectId, buildId, { kind: 'show', signingKey: SIGNING_KEY });
    expect(link.linkId).not.toBeNull();
    const w = await getFixWorkspace(db(), store, projectId);
    expect(w.current).toMatchObject({ status: 'SHOWN', confirmed: true, approvedBy: 'Sam' });
    expect(w.steps).toMatchObject({ confirm: 'done', show: 'done' });
  });

  it('keeps approval a person\'s decision: an agent cannot approve or show a fix', async () => {
    const { projectId, buildId, seed } = await generated();
    await confirmFix(db(), projectId, buildId, { confirmedBy: 'Sam', confirmed: true, at: AT });
    await confirmRecheck(db(), seed, '2026-10-01T09:00:00Z');
    await withAgentActor(db(), async () => {
      expect(await refused(db(), () => markBuildShown(db(), buildId, AT))).toMatch(/build agent cannot mark a build shown/);
    });
  });

  it('a version whose corrected value was withdrawn cannot be approved or shown; the new value makes a new version', async () => {
    const { projectId, buildId, store, correction } = await generated();
    await proposeCorrection(db(), projectId, { evidenceId: correction.evidenceId, channel: 'phone', value: '+442079460001' });
    expect(await refused(db(), () => approveBuild(db(), buildId, 'Sam', AT))).toMatch(/uses a corrected value that was withdrawn/);
    const w = await getFixWorkspace(db(), store, projectId);
    expect(w.current).toMatchObject({ stale: true });
    expect(w.steps.beforeAfter).toBe('current');
    const next = await generateFix(db(), { store }, projectId);
    expect(next.status).toBe('SUCCEEDED');
    expect(await refused(db(), () => confirmFix(db(), projectId, buildId, { confirmedBy: 'Sam', confirmed: true }))).toMatch(/newer version exists/);
    await confirmFix(db(), projectId, String(next.buildId), { confirmedBy: 'Sam', confirmed: true, at: AT });
    expect(await refused(db(), () => generateFix(db(), { store }, projectId))).toMatch(/already made with these destinations/);
  });

  it('11. an approved fix version and what it applied never change', async () => {
    const { projectId, buildId, correction } = await generated();
    await confirmFix(db(), projectId, buildId, { confirmedBy: 'Sam', confirmed: true, at: AT });
    expect(await failure(db(), `UPDATE builds SET summary = 'changed' WHERE id = $1`, [buildId])).toMatch(/approved content changed/);
    expect(await failure(db(), 'DELETE FROM build_fix_corrections WHERE build_id = $1', [buildId])).toMatch(/approved version applied never changes/);
    expect(await failure(db(), 'UPDATE build_fix_corrections SET correction_id = correction_id WHERE build_id = $1', [buildId])).toMatch(/never changes/);
    const other = await proposeCorrection(db(), projectId, { evidenceId: correction.evidenceId, channel: 'phone', value: '+442079460001' });
    expect(await failure(db(), 'INSERT INTO build_fix_corrections (build_id, correction_id) VALUES ($1, $2)', [buildId, other.correctionId]))
      .toMatch(/approved version applied never changes/);
  });

  it('links a version only to a standing correction of its own project', async () => {
    const a = await generated();
    const b = await generated();
    expect(await failure(db(), 'INSERT INTO build_fix_corrections (build_id, correction_id) VALUES ($1, $2)', [a.buildId, b.correction.correctionId]))
      .toMatch(/not part of build/);
    const site = await seedWebsiteOpportunity(db());
    const sp = await openWebsiteProject(db(), site.opportunityId);
    void sp;
    await db().query('UPDATE fix_corrections SET withdrawn_at = now() WHERE id = $1', [a.correction.correctionId]);
    const v2 = await failure(db(), 'DELETE FROM build_fix_corrections WHERE build_id = $1', [a.buildId]);
    expect(v2).toBeNull();
    expect(await failure(db(), 'INSERT INTO build_fix_corrections (build_id, correction_id) VALUES ($1, $2)', [a.buildId, a.correction.correctionId]))
      .toMatch(/was withdrawn/);
    expect(await failure(db(), `UPDATE builds SET status = 'APPROVED', approved_by = 'Sam', approved_at = $2 WHERE id = $1`, [a.buildId, AT]))
      .toMatch(/applies no corrected value/);
  });

  it('refuses an approved or shown fix version recorded directly, without its confirmation', async () => {
    const { projectId, seed } = await generated();
    const cat = await catalogId(db(), 'website_fix_sprint');
    expect(await failure(db(), `WITH b AS (INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, generator, project_id, artifact_ref, approved_by, approved_at, status)
      VALUES ($1, $2, 'website_fix', 'DEMO', 't', 's', 'operator', $3, 'operator-ref', 'Sam', now(), 'APPROVED') RETURNING id)
      INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $4 FROM b`, [seed.opportunityId, cat, projectId, seed.evidenceId]))
      .toMatch(/FIX: this fix version applies no corrected value/);
  });
});

// ================================================================== 13, 14, 15. preview, signed links, expiry and revocation

describe('the prospect sees the confirmed fix through a signed, expiring, revocable link', () => {
  async function shown() {
    const g = await generated();
    await confirmFix(db(), g.projectId, g.buildId, { confirmedBy: 'Sam', confirmed: true, at: AT });
    await confirmRecheck(db(), g.seed, '2026-10-01T09:00:00Z');
    await showFixVersion(db(), g.projectId, g.buildId, { at: AT });
    return g;
  }

  it('13. the preview shows the observed problem and the link before and after, and states nothing else', async () => {
    const { projectId, buildId, store } = await shown();
    const now = Math.floor(Date.now() / 1000);
    const link = await previewLink(db(), projectId, buildId, { kind: 'show', signingKey: SIGNING_KEY, nowSeconds: now });
    const art = await loadPreviewArtifact(db(), store, verifyPreview(SIGNING_KEY, link.token, now)!);
    expect(art).toMatchObject({ buildKind: 'website_fix', status: 'SHOWN' });
    const html = art!.html.toString('utf8');
    expect(html).toContain('WhatsApp label opens a phone call');
    expect(html).toContain('href=&quot;tel:WhatsApp:0800&quot;');
    expect(html).toContain(`<a class="lnk" href="${CORRECTED}"`);
    expect(html).toContain('<s>tel:WhatsApp:0800</s>');
    expect(html).toContain('nothing on your live website has been changed');
    expect(html).toContain('Only the destination of these 2 links changes');
    expect(html).not.toMatch(/<script|https?:\/\/(?!wa\.me|example-clinic\.test)/i);
    expect(html).not.toContain('workspaces/');
  });

  it('14. a show link opens only its own version; the page copies open only through an edit link', async () => {
    const { projectId, buildId, store } = await shown();
    const now = Math.floor(Date.now() / 1000);
    const show = await previewLink(db(), projectId, buildId, { kind: 'show', signingKey: SIGNING_KEY, nowSeconds: now });
    const claims = verifyPreview(SIGNING_KEY, show.token, now)!;
    expect(verifyPreview(SIGNING_KEY, `${show.token.slice(0, -2)}xx`, now)).toBeNull();
    expect(verifyPreview('another-signing-key-0123456789abcdef', show.token, now)).toBeNull();
    expect(await loadPreviewArtifact(db(), store, { ...claims, b: String(Number(buildId) + 999) })).toBeNull();
    expect(await readFixPage(db(), store, projectId, String(Number(buildId) + 999), 'before')).toBeNull();
  });

  it('15. a link stops at its expiry or when revoked, and the version does not change', async () => {
    const { projectId, buildId, store } = await shown();
    const now = Math.floor(Date.now() / 1000);
    const link = await previewLink(db(), projectId, buildId, { kind: 'show', signingKey: SIGNING_KEY, nowSeconds: now });
    expect(verifyPreview(SIGNING_KEY, link.token, now + 72 * 3600 + 1)).toBeNull();
    const listed = await listProspectLinks(db(), projectId, { signingKey: SIGNING_KEY, at: new Date((now + 72 * 3600 + 1) * 1000).toISOString() });
    expect(listed[0]).toMatchObject({ state: 'EXPIRED', token: null });
    const claims = verifyPreview(SIGNING_KEY, link.token, now)!;
    expect(await loadPreviewArtifact(db(), store, claims)).not.toBeNull();
    await revokeProspectLink(db(), projectId, link.linkId!, { revokedBy: 'Sam' });
    expect(await loadPreviewArtifact(db(), store, claims)).toBeNull();
    expect((await listProspectLinks(db(), projectId, { signingKey: SIGNING_KEY }))[0]).toMatchObject({ state: 'REVOKED' });
    expect((await one<{ s: string }>(db(), 'SELECT status AS s FROM builds WHERE id = $1', [buildId])).s).toBe('SHOWN');
  });
});

// ================================================================== 2. workspace isolation

describe('a fix stays inside its workspace', () => {
  it('reads another workspace\'s fix as missing and refuses every write into it', async () => {
    const A = await generated();
    const wsA = await WS();
    await enterNewWorkspace(db(), 'beta');
    const store = A.store;
    expect(await refused(db(), () => getFixWorkspace(db(), store, A.projectId))).toMatch(/That fix does not exist/);
    expect(await refused(db(), () => captureFixPage(db(), { store, fetcher: new StubFetcher() }, A.projectId, { evidenceId: A.seed.evidenceId }))).toMatch(/does not exist/);
    expect(await refused(db(), () => proposeCorrection(db(), A.projectId, { evidenceId: A.seed.evidenceId, channel: 'whatsapp', value: '447700900123' }))).toMatch(/does not exist/);
    expect(await refused(db(), () => generateFix(db(), { store }, A.projectId))).toMatch(/does not exist/);
    expect(await refused(db(), () => confirmFix(db(), A.projectId, A.buildId, { confirmedBy: 'x', confirmed: true }))).toMatch(/does not exist/);
    expect(await refused(db(), () => openFixProject(db(), A.seed.opportunityId))).toMatch(/does not exist/);
    expect(await readFixPage(db(), store, A.projectId, A.buildId, 'before')).toBeNull();
    const B = await seedFixOpportunity(db());
    const bp = await openFixProject(db(), B.opportunityId);
    const cross = /WORKSPACE: .* belongs to workspace/;
    expect(await failure(db(), `INSERT INTO fix_corrections (project_id, evidence_id, capture_id, channel, corrected_href, proposed_by)
      VALUES ($1, $2, $3, 'whatsapp', $4, 'x')`, [bp, B.evidenceId, A.capture.captureId, CORRECTED])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO build_fix_corrections (build_id, correction_id) VALUES ($1, $2)`, [A.buildId, A.correction.correctionId])).toMatch(cross);
    expect(await failure(db(), `INSERT INTO fix_captures (project_id, evidence_id, requested_url, final_url, http_status, content_type, storage_ref, sha256, byte_size,
      observed_href, href_occurrences, captured_by) VALUES ($1, $2, 'https://e.test/', 'https://e.test/', 200, 'text/html', 'workspaces/1/projects/1/captures/x', repeat('a',64), 1, 'x', 1, 'x')`,
      [A.projectId, B.evidenceId])).toMatch(cross);
    const beta = await WS();
    await useWorkspace(db(), wsA);
    expect(await failure(db(), 'UPDATE fix_captures SET workspace_id = $2 WHERE id = $1', [A.capture.captureId, beta])).toMatch(/cannot move|never changes/);
    expect(await failure(db(), 'UPDATE fix_corrections SET workspace_id = $2 WHERE id = $1', [A.correction.correctionId, beta])).toMatch(/cannot move/);
  });

  it('row-level security shows each workspace only its own captures, corrections and links', async () => {
    const A = await generated();
    const wsA = await WS();
    const wsB = await enterNewWorkspace(db(), 'beta');
    const B = await generated();
    void B;
    for (const ws of [wsA, wsB]) {
      await asApp(db(), ws, async () => {
        for (const t of ['fix_captures', 'fix_corrections', 'build_fix_corrections']) {
          const other = await one<{ n: string }>(db(), `SELECT count(*) AS n FROM ${t} WHERE workspace_id <> $1`, [ws]);
          expect(other.n, t).toBe('0');
          const mine = await one<{ n: string }>(db(), `SELECT count(*) AS n FROM ${t}`);
          expect(Number(mine.n), t).toBeGreaterThan(0);
        }
      });
    }
    await asApp(db(), null, async () => {
      expect((await db().query('SELECT 1 FROM fix_captures')).rows).toEqual([]);
    });
    void A;
    const tables = ['fix_captures', 'fix_corrections', 'build_fix_corrections'];
    const guarded = (await db().query(`SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'a00_workspace_guard' AND c.relname = ANY ($1)`, [tables])).rows.map((r) => r.relname).sort();
    expect(guarded).toEqual([...tables].sort());
  });
});

// ================================================================== 16. the website path is unchanged

describe('the website path and earlier fix builds are unchanged', () => {
  it('adds no fix reason to a website version or to a website_fix build made without the Fix Builder', async () => {
    const site = await seedWebsiteOpportunity(db());
    const sp = await openWebsiteProject(db(), site.opportunityId);
    expect(await refused(db(), () => getFixWorkspace(db(), newStore(), sp))).toMatch(/not a website fix/);
    const seed = await seedFixOpportunity(db());
    const cat = await catalogId(db(), 'website_fix_sprint');
    // Slice 2's operator path: a website_fix build with no capture approves as before.
    const b = await one<{ id: string }>(db(), `WITH b AS (INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, generator, artifact_ref)
      VALUES ($1, $2, 'website_fix', 'DEMO', 't', 's', 'operator', 'operator-ref') RETURNING id), e AS (INSERT INTO build_evidence (build_id, evidence_id) SELECT id, $3 FROM b)
      SELECT id FROM b`, [seed.opportunityId, cat, seed.evidenceId]);
    expect((await one<{ r: string | null }>(db(), 'SELECT scopely.fix_build_blocker($1) AS r', [b.id])).r).toBeNull();
    expect((await one<{ r: string | null }>(db(), 'SELECT scopely.build_approve_blocker($1) AS r', [b.id])).r).toBeNull();
    await approveBuild(db(), b.id, 'Sam', AT);
  });
});

// ================================================================== the capture fetcher's SSRF guard

describe('the live capture reaches only public web pages', () => {
  it('refuses private, loopback, link-local, reserved and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('refuses other schemes, ports, credentials and local names before any lookup', () => {
    for (const u of ['ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://example.com:8080/', 'http://localhost/',
      'http://printer.local/', 'http://127.0.0.1/', 'http://[::1]/', 'javascript:alert(1)']) {
      expect(() => assertCapturableUrl(u), u).toThrow();
    }
    expect(assertCapturableUrl('https://example.com/contact').hostname).toBe('example.com');
  });

  it('refuses a name that resolves to a private address, and never connects', async () => {
    const f = new SafePageFetcher(async () => ['10.0.0.5']);
    await expect(f.fetch('https://intranet.example.com/')).rejects.toThrow(/not on the public web/);
    const g = new SafePageFetcher(async () => ['93.184.216.34', '127.0.0.1']);
    await expect(g.fetch('https://mixed.example.com/')).rejects.toThrow(/not on the public web/);
  });
});
