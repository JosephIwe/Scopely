// Migration 006 and src/build: the BUILD/FIX boundary. A build fixes something observed on a
// mapped opportunity, is approved before a prospect sees it, and never counts as delivery.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { approveBuild, BuilderRegistry, loadBuildInput, markBuildShown, recordBuild, runBuilder, type FixBuilder } from '../src/build/index.js';
import { catalogId, failure, one, seedChain, seedOpportunity, useDb } from './helpers.js';

const { db } = useDb();

const buildSql = `INSERT INTO builds (opportunity_id, catalog_item_id, build_kind, purpose, title, summary, artifact_ref, generator)
  VALUES ($1, $2, $3, $4, 'Fixed contact links', 'Corrected WhatsApp and phone links', 's3://builds/1', 'operator') RETURNING id`;

async function draftBuild(d: pg.Client, purpose: 'DEMO' | 'DELIVERY' = 'DEMO') {
  const c = await seedChain(d);
  const opp = await seedOpportunity(d, c);
  const cat = await catalogId(d, 'website_fix_sprint');
  const b = await one<{ id: string }>(d, buildSql, [opp, cat, 'website_fix', purpose]);
  await d.query('INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)', [b.id, c.evidenceId]);
  return { c, opp, cat, buildId: b.id };
}

/** Confirms the chain's evidence on a later snapshot so it may be shown. */
async function confirmEvidence(d: pg.Client, c: Awaited<ReturnType<typeof seedChain>>, at = '2026-10-01T09:00:00Z') {
  const s = await one<{ id: string }>(d, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://example-clinic.test/', $2, 'manual') RETURNING id`, [c.businessId, at]);
  const o = await one<{ id: string }>(d, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect') RETURNING id`, [s.id, c.ruleId]);
  await d.query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1,$2,$3,'confirmed','joseph')`, [c.evidenceId, s.id, o.id]);
}

describe('build kinds are data and catalog items declare what they build', () => {
  it('seeds the build kinds and maps each seeded service to one', async () => {
    const kinds = (await db().query('SELECT key FROM build_kinds ORDER BY key')).rows.map((r) => r.key);
    expect(kinds).toEqual(['automation', 'booking_flow', 'conversion_improvement', 'landing_page', 'lead_recovery',
      'seo_improvement', 'website', 'website_fix']);
    const items = (await db().query('SELECT key, build_kind FROM catalog_items ORDER BY key')).rows;
    expect(items).toEqual([
      { key: 'booking_lead_automation_sprint', build_kind: 'booking_flow' },
      { key: 'landing_page_build', build_kind: 'landing_page' },
      { key: 'lead_recovery_system', build_kind: 'lead_recovery' },
      { key: 'website_fix_sprint', build_kind: 'website_fix' },
    ]);
  });
  it('adds a new build kind without a schema change', async () => {
    expect(await failure(db(), `INSERT INTO build_kinds (key, name, description) VALUES ('review_widget', 'Review widget', 'x')`)).toBeNull();
  });
});

describe('a build fixes something observed on a mapped opportunity', () => {
  it('records a draft demo build citing the opportunity evidence', async () => {
    const { buildId } = await draftBuild(db());
    await db().query('SET CONSTRAINTS ALL IMMEDIATE');
    expect(buildId).toBeTruthy();
  });
  it('refuses a build with no evidence at commit', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), buildSql, [opp, await catalogId(db(), 'website_fix_sprint'), 'website_fix', 'DEMO'])).toMatch(/cites no evidence/);
  });
  it('refuses removing the last evidence of a build', async () => {
    const { buildId, c } = await draftBuild(db());
    await db().query('SET CONSTRAINTS ALL IMMEDIATE'); // settle the insert, so only the delete is judged
    expect(await failure(db(), 'DELETE FROM build_evidence WHERE build_id = $1 AND evidence_id = $2', [buildId, c.evidenceId])).toMatch(/cites no evidence/);
  });
  it('refuses evidence from outside the build opportunity', async () => {
    const { buildId } = await draftBuild(db());
    const other = await seedChain(db());
    expect(await failure(db(), 'INSERT INTO build_evidence (build_id, evidence_id) VALUES ($1, $2)', [buildId, other.evidenceId])).toMatch(/not part of the build's opportunity/);
  });
  it('refuses an UNMAPPED opportunity or a catalog item other than the mapped one', async () => {
    const c = await seedChain(db());
    const unmapped = await one<{ id: string }>(db(), `INSERT INTO opportunities (business_id, opportunity_type, unmapped_reason) VALUES ($1, 't', 'no service fits') RETURNING id`, [c.businessId]);
    await db().query('INSERT INTO opportunity_evidence VALUES ($1, $2)', [unmapped.id, c.evidenceId]);
    expect(await failure(db(), buildSql, [unmapped.id, await catalogId(db(), 'website_fix_sprint'), 'website_fix', 'DEMO'])).toMatch(/mapped catalog item/);
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), buildSql, [opp, await catalogId(db(), 'lead_recovery_system'), 'lead_recovery', 'DEMO'])).toMatch(/mapped catalog item/);
  });
  it('refuses a build kind the catalog item does not build, or an item with no build path', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    expect(await failure(db(), buildSql, [opp, await catalogId(db(), 'website_fix_sprint'), 'landing_page', 'DEMO'])).toMatch(/builds website_fix, not landing_page/);
    await db().query(`UPDATE catalog_items SET build_kind = NULL WHERE key = 'website_fix_sprint'`);
    expect(await failure(db(), buildSql, [opp, await catalogId(db(), 'website_fix_sprint'), 'website_fix', 'DEMO'])).toMatch(/builds nothing/);
  });
  it('a DELIVERY build needs a won opportunity', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const cat = await catalogId(db(), 'website_fix_sprint');
    expect(await failure(db(), buildSql, [opp, cat, 'website_fix', 'DELIVERY'])).toMatch(/needs a won opportunity/);
    const outcome = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, recorded_by) VALUES ($1,$2,$3,$4,$5,'joseph')`;
    await db().query(outcome, [opp, 'pitched', '2026-10-01', null, null]);
    await db().query(outcome, [opp, 'won', '2026-10-02', 120, 'GBP']);
    const b = await one<{ id: string }>(db(), buildSql, [opp, cat, 'website_fix', 'DELIVERY']);
    await db().query('INSERT INTO build_evidence VALUES ($1, $2)', [b.id, c.evidenceId]);
    await db().query('SET CONSTRAINTS ALL IMMEDIATE');
  });
  it('supersedes only a build of the same opportunity', async () => {
    const a = await draftBuild(db());
    const b = await draftBuild(db());
    expect(await failure(db(), `UPDATE builds SET supersedes_build_id = $2 WHERE id = $1`, [b.buildId, a.buildId])).toMatch(/same opportunity/);
  });
  it('a build is not delivery: a delivered outcome still needs a win', async () => {
    const { opp } = await draftBuild(db());
    expect(await failure(db(), `INSERT INTO outcomes (opportunity_id, kind, occurred_at, delivered_by, recorded_by) VALUES ($1, 'delivered', now(), 'operator', 'joseph')`, [opp]))
      .toMatch(/before a won outcome/);
  });
});

describe('showing a build is approved and gated like a send', () => {
  const approve = `UPDATE builds SET status = 'APPROVED', approved_by = 'joseph', approved_at = '2026-10-01T10:00:00Z' WHERE id = $1`;
  const show = `UPDATE builds SET status = 'SHOWN', shown_at = $2 WHERE id = $1`;
  it('refuses showing an unapproved build', async () => {
    const { buildId } = await draftBuild(db());
    expect(await failure(db(), `UPDATE builds SET status = 'SHOWN', shown_at = now() WHERE id = $1`, [buildId])).toMatch(/check constraint/);
  });
  it('refuses a half-recorded approval or show', async () => {
    const { buildId, c } = await draftBuild(db());
    await db().query(`UPDATE evidence SET confidence = 'MEDIUM' WHERE id = $1`, [c.evidenceId]); // isolate the CHECKs from the re-check gate
    expect(await failure(db(), `UPDATE builds SET approved_by = 'joseph' WHERE id = $1`, [buildId])).toMatch(/check constraint/);
    expect(await failure(db(), `UPDATE builds SET approved_at = now() WHERE id = $1`, [buildId])).toMatch(/check constraint/);
    expect(await failure(db(), `UPDATE builds SET approved_by = ' ', approved_at = now() WHERE id = $1`, [buildId])).toMatch(/check constraint/);
    await db().query(approve, [buildId]);
    expect(await failure(db(), `UPDATE builds SET status = 'SHOWN' WHERE id = $1`, [buildId])).toMatch(/check constraint/);
    expect(await failure(db(), `UPDATE builds SET shown_at = '2026-10-01T12:00:00Z' WHERE id = $1`, [buildId])).toMatch(/check constraint/);
  });
  it('refuses approving a build with no artifact', async () => {
    const { buildId } = await draftBuild(db());
    await db().query('UPDATE builds SET artifact_ref = NULL WHERE id = $1', [buildId]);
    expect(await failure(db(), approve, [buildId])).toMatch(/check constraint/);
  });
  it('refuses showing a build whose HIGH evidence was not re-checked, and accepts it once confirmed', async () => {
    const { buildId, c } = await draftBuild(db());
    await db().query(approve, [buildId]);
    expect(await failure(db(), show, [buildId, '2026-10-01T12:00:00Z'])).toMatch(/no confirmed re-check/);
    await confirmEvidence(db(), c);
    expect(await failure(db(), show, [buildId, '2026-10-01T12:00:00Z'])).toBeNull();
  });
  it('a DELIVERY build is never shown as a pitch', async () => {
    const { c, opp, cat } = await draftBuild(db());
    const outcome = `INSERT INTO outcomes (opportunity_id, kind, occurred_at, amount, currency, recorded_by) VALUES ($1,$2,$3,$4,$5,'joseph')`;
    await db().query(outcome, [opp, 'pitched', '2026-10-01', null, null]);
    await db().query(outcome, [opp, 'won', '2026-10-02', 120, 'GBP']);
    const d = await one<{ id: string }>(db(), buildSql, [opp, cat, 'website_fix', 'DELIVERY']);
    await db().query('INSERT INTO build_evidence VALUES ($1, $2)', [d.id, c.evidenceId]);
    await confirmEvidence(db(), c);
    await db().query(approve, [d.id]);
    expect(await failure(db(), show, [d.id, '2026-10-03T12:00:00Z'])).toMatch(/check constraint/);
  });
  it('freezes approved content and evidence, and a shown build entirely', async () => {
    const { buildId, c } = await draftBuild(db());
    await db().query(approve, [buildId]);
    expect(await failure(db(), `UPDATE builds SET artifact_ref = 's3://builds/2' WHERE id = $1`, [buildId])).toMatch(/needs a new approval/);
    expect(await failure(db(), 'DELETE FROM build_evidence WHERE build_id = $1', [buildId])).toMatch(/approved build cannot change/);
    await confirmEvidence(db(), c);
    await db().query(show, [buildId, '2026-10-01T12:00:00Z']);
    expect(await failure(db(), `UPDATE builds SET summary = 'x', approved_at = '2026-10-01T13:00:00Z' WHERE id = $1`, [buildId])).toMatch(/shown build cannot change/);
  });
  it('refuses adding evidence to an approved build', async () => {
    const { buildId, c, opp } = await draftBuild(db());
    const extra = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result)
      VALUES ($1, 'contact_links.tel', $2, 'OBSERVED', 'defect') RETURNING id`, [c.snapshotId, c.ruleId]);
    const e = await one<{ id: string }>(db(), `INSERT INTO evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, confidence)
      VALUES ($1, $2, 'E-TEL-BROKEN', $3, 'OBSERVED', 'x', 'https://example-clinic.test/', 'tel:+440', 'MEDIUM') RETURNING id`, [c.businessId, extra.id, c.ruleId]);
    await db().query('INSERT INTO opportunity_evidence VALUES ($1, $2)', [opp, e.id]);
    await db().query(approve, [buildId]);
    expect(await failure(db(), 'INSERT INTO build_evidence VALUES ($1, $2)', [buildId, e.id])).toMatch(/approved build cannot change/);
  });
});

describe('build cost is metered against the build and its opportunity', () => {
  it('accepts a build cost on the build opportunity and refuses one on another', async () => {
    const { buildId, opp } = await draftBuild(db());
    const other = await draftBuild(db());
    const sql = `INSERT INTO cost_events (opportunity_id, build_id, kind, minutes) VALUES ($1, $2, 'operator_time', 30)`;
    expect(await failure(db(), sql, [opp, buildId])).toBeNull();
    expect(await failure(db(), sql, [other.opp, buildId])).toMatch(/not part of opportunity/);
    expect(await failure(db(), `INSERT INTO cost_events (business_id, build_id, kind) VALUES ($1, $2, 'build')`, [other.c.businessId, buildId])).toMatch(/check constraint/);
    expect(await failure(db(), `INSERT INTO cost_events (opportunity_id, build_id, kind) VALUES ($1, $2, 'build')`, [opp, buildId])).toBeNull();
    expect(await failure(db(), `INSERT INTO cost_events (opportunity_id, kind) VALUES ($1, 'guesswork')`, [opp])).toMatch(/check constraint/);
  });
});

describe('the builder seam', () => {
  const stub: FixBuilder = {
    kind: 'website_fix', version: 'test-1',
    build: async (input) => ({ title: `Fix for ${input.business.name}`, summary: `${input.evidence.length} fixes`, artifactRef: 'mem://stub' }),
  };
  it('gives a builder only the cited evidence and what could not be observed', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    await db().query(`UPDATE opportunities SET not_observable_notes = 'Booking widget is rendered by JavaScript; not seen' WHERE id = $1`, [opp]);
    await seedChain(db()); // unrelated evidence must not leak in
    const input = await loadBuildInput(db(), opp);
    expect(input.buildKind).toBe('website_fix');
    expect(input.evidence.map((e) => e.id)).toEqual([String(c.evidenceId)]);
    expect(input.evidence[0]).toMatchObject({ issueCode: 'E-LINK-TARGET-MISMATCH', quote: 'href="tel:WhatsApp:0800"', claimState: 'OBSERVED' });
    expect(input.notObservable).toMatch(/not seen/);
    expect(Object.keys(input)).not.toContain('html');
  });
  it('excludes evidence a re-check found gone, and refuses when nothing still holds', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const s = await one<{ id: string }>(db(), `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'u', '2026-10-01', 'manual') RETURNING id`, [c.businessId]);
    const o = await one<{ id: string }>(db(), `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'ok') RETURNING id`, [s.id, c.ruleId]);
    await db().query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1,$2,$3,'gone','joseph')`, [c.evidenceId, s.id, o.id]);
    await expect(loadBuildInput(db(), opp)).rejects.toThrow(/no evidence that still holds/);
  });
  it('refuses UNMAPPED opportunities and items with no build kind', async () => {
    const c = await seedChain(db());
    const unmapped = await one<{ id: string }>(db(), `INSERT INTO opportunities (business_id, opportunity_type, unmapped_reason) VALUES ($1, 't', 'none') RETURNING id`, [c.businessId]);
    await db().query('INSERT INTO opportunity_evidence VALUES ($1, $2)', [unmapped.id, c.evidenceId]);
    await expect(loadBuildInput(db(), unmapped.id)).rejects.toThrow(/UNMAPPED/);
    const opp = await seedOpportunity(db(), c);
    await db().query(`UPDATE catalog_items SET build_kind = NULL WHERE key = 'website_fix_sprint'`);
    await expect(loadBuildInput(db(), opp)).rejects.toThrow(/no build kind/);
  });
  it('has no builders registered by default and refuses an unknown kind', () => {
    const reg = new BuilderRegistry();
    expect(reg.kinds()).toEqual([]);
    expect(() => reg.get('website')).toThrow(/no builder/);
    reg.register(stub);
    expect(() => reg.register(stub)).toThrow(/already registered/);
  });
  it('runs a registered builder into a DRAFT build that traces to the builder version', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const reg = new BuilderRegistry();
    reg.register(stub);
    const id = await runBuilder(db(), reg, opp, 'DEMO');
    await db().query('SET CONSTRAINTS ALL IMMEDIATE');
    const b = await one<{ status: string; generator: string; purpose: string }>(db(), 'SELECT status, generator, purpose FROM builds WHERE id = $1', [id]);
    expect(b).toEqual({ status: 'DRAFT', generator: 'website_fix:test-1', purpose: 'DEMO' });
  });
  it('records an operator-made build, approves it and marks it shown', async () => {
    const c = await seedChain(db());
    const opp = await seedOpportunity(db(), c);
    const input = await loadBuildInput(db(), opp);
    const id = await recordBuild(db(), input, { title: 't', summary: 's', artifactRef: 'file://demo.html' }, { purpose: 'DEMO', generator: 'operator' });
    await approveBuild(db(), id, 'joseph', '2026-10-01T10:00:00Z');
    await confirmEvidence(db(), c);
    await markBuildShown(db(), id, '2026-10-01T12:00:00Z');
    const l = await one<{ demo_builds_shown: string }>(db(), 'SELECT demo_builds_shown FROM v_opportunity_ledger WHERE opportunity_id = $1', [opp]);
    expect(Number(l.demo_builds_shown)).toBe(1);
  });
});
