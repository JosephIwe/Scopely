// The product test. User A runs "Manchester Plumbers" end to end: 200 discovered, pre-qualified,
// 50 selected and analysed within budget, WEBSITE and FIX opportunities in one feed, demos built,
// sold, delivered and verified. User B independently runs "Toronto Dental Clinics" and, acting as
// the application role, sees none of User A's businesses, searches, contacts, opportunities,
// messages, costs or mailbox. All values are fixtures.
import { describe, expect, it } from 'vitest';
import { getBusinessDetail, getSearchPerformance, getSearchRunStageFunnel, getSearchRunSummary, listMapBusinesses, listOpportunities } from '../src/api/queries.js';
import { approveBuild, loadBuildInput, markBuildShown, recordBuild } from '../src/build/index.js';
import {
  concludeAnalysis, createSearch, estimateRunAnalysis, markAnalyzed, prequalifyRun, queueForAnalysis, recordDiscoveredBusiness,
  selectForAnalysis, startSearchRun, type DiscoveredBusiness,
} from '../src/discovery/index.js';
import { recordWebsiteStatus } from '../src/discovery/website.js';
import * as rec from '../src/record/index.js';
import { listMailboxes, registerManualMailbox } from '../src/sell/mailbox.js';
import { createWorkspace, withWorkspace } from '../src/tenancy/index.js';
import { asApp, one, refused, useDb } from './helpers.js';

const { db } = useDb();
const T = (h: number) => new Date(Date.UTC(2026, 9, 1, 8) + h * 3600_000).toISOString();

describe('User A: Manchester Plumbers, from discovery to verified revenue', () => {
  it('runs the whole loop in one workspace, and User B sees none of it', async () => {
    // ---------------------------------------------------------------- workspaces (provisioning)
    const a = await createWorkspace(db(), { slug: 'seller-a', name: 'Seller A', owner: { email: 'owner@seller-a.test' } });
    const b = await createWorkspace(db(), { slug: 'seller-b', name: 'Seller B', owner: { email: 'owner@seller-b.test' } });

    // ---------------------------------------------------------------- User A
    const A = await withWorkspace(db(), a.workspaceId, async () => {
      const mailbox = await registerManualMailbox(db(), { provider: 'google_workspace', email: 'hello@seller-a.test', connectedByUserId: a.ownerUserId! });
      const websiteBuild = (await one<{ id: string }>(db(), `INSERT INTO catalog_items (key, service, description, build_kind, supported_issue_codes)
        VALUES ('website_build', 'Website Build', 'A new website for a business without one. Price not set yet.', 'website', ARRAY['E-NO-WEBSITE'])
        RETURNING id`)).id;
      const searchId = await createSearch(db(), {
        name: 'Manchester Plumbers', countryCode: 'GB', city: 'Manchester', subverticals: ['plumbing'],
        employeeMin: 5, employeeMax: 30, revenueMin: 250_000, revenueMax: 5_000_000, revenueCurrency: 'GBP',
        businessTypes: ['independent'], excludeChains: true, opportunityKinds: ['website', 'lead_recovery'],
        maxBusinessesToAnalyze: 50, analysisBudgetCredits: 400, createdByUserId: a.ownerUserId!,
      });
      const runId = await startSearchRun(db(), searchId, a.ownerUserId!);

      // 200 discovered. Every tenth kind of business misses one criterion; kind 4 has no size data.
      const hasSite = new Map<string, boolean>();
      for (let i = 0; i < 200; i += 1) {
        const kind = i % 10;
        const noSite = kind >= 5 && i % 2 === 1;
        const d: DiscoveredBusiness = {
          source: { provider: 'fixture_directory', sourceType: 'directory', reference: `mcr-plumbers/${i}`, discoveredAt: T(0) },
          name: `Manchester Plumbing ${i}`, domain: noSite ? undefined : `mcr-plumbing-${i}.test`, subvertical: 'plumbing', vertical: 'home_services',
          city: kind === 0 ? 'Leeds' : 'Manchester', countryCode: 'GB', companyType: 'ltd', companyStatus: 'active',
          independence: kind === 3 ? 'chain' : 'independent',
          geo: { latitude: 53.48 + i / 10_000, longitude: -2.24, source: 'fixture_directory' },
          employees: kind === 4 ? undefined : { count: kind === 1 ? 120 : 12, basis: 'REPORTED', source: 'fixture_directory', asOf: T(0) },
          revenue: { amount: kind === 2 ? 10_000_000 : 800_000, currency: 'GBP', basis: 'ESTIMATED', source: 'fixture_estimate', asOf: T(0) },
        };
        const r = await recordDiscoveredBusiness(db(), runId, d);
        hasSite.set(r.businessId, !noSite);
      }
      expect(await prequalifyRun(db(), runId, new Date(T(1)))).toEqual({ qualified: 100, rejected: 80, needsReview: 20 });
      const funnel = await getSearchRunStageFunnel(db(), runId);
      expect(funnel.slice(0, 5).map((f) => [f.stage, f.remainingAfterStage])).toEqual([
        ['geography', 180], ['industry', 180], ['size', 160], ['revenue', 140], ['structure', 120]]);

      // Select 50 of the 100 that fit, at 8 credits each: exactly the 400-credit budget.
      const qualified = (await db().query(`SELECT business_id FROM search_run_businesses WHERE search_run_id = $1 AND state = 'QUALIFIED' ORDER BY id`,
        [runId])).rows.map((r) => String(r.business_id));
      const picked = qualified.slice(0, 50);
      await selectForAnalysis(db(), runId, picked.map((businessId) => ({ businessId, estimatedCredits: 8 })), 'owner', T(1));
      expect(await refused(db(), () => selectForAnalysis(db(), runId, [{ businessId: qualified[50]!, estimatedCredits: 8 }], 'owner', T(1))))
        .toMatch(/limit of 50/);
      expect(await estimateRunAnalysis(db(), runId)).toMatchObject({ selected: 50, estimatedCredits: '400.0000', availableCredits: '400.0000', fitsBudget: true });
      await queueForAnalysis(db(), runId, picked, T(1));

      // Analysis: metered per business; no-website businesses become WEBSITE opportunities, businesses
      // with a site and a contradicted 24/7 claim become FIX (lead recovery) opportunities, some have none.
      const rule = async (key: string) => (await one<{ id: string }>(db(), 'SELECT id FROM rule_versions WHERE rule_key = $1 AND version = 1', [key])).id;
      const presence = await rule('check.website_presence'), hours = await rule('check.trades_hours_and_routes');
      const opps: { id: string; businessId: string; path: 'WEBSITE' | 'FIX'; evidenceId: string; checkCode: string; ruleId: string }[] = [];
      for (const [n, businessId] of picked.entries()) {
        await db().query(`INSERT INTO cost_events (business_id, search_run_id, kind, credits, amount, currency) VALUES ($1, $2, 'render', 8, 0.02, 'GBP')`,
          [businessId, runId]);
        await markAnalyzed(db(), runId, businessId, T(2));
        const site = hasSite.get(businessId)!;
        if (!site) {
          await recordWebsiteStatus(db(), businessId, { status: 'WEBSITE_NOT_OBSERVED', basis: 'OBSERVED', source: 'directory listing has no website', checkedAt: T(2) });
        } else if (n % 5 === 0) {
          await concludeAnalysis(db(), runId, businessId, T(2));   // nothing worth selling
          continue;
        }
        const snap = await rec.recordSnapshot(db(), { businessId, url: site ? `https://mcr-plumbing.test/${n}` : `https://directory.test/mcr/${n}`, fetchedAt: T(2), fetchMethod: 'manual' });
        const f = await rec.recordFinding(db(), site
          ? { snapshotId: snap, ruleKey: 'check.trades_hours_and_routes', checkCode: 'trades.24_7_claim', state: 'OBSERVED', result: 'gap',
              evidence: { issueCode: 'E-24-7-CONTRADICTION', claimState: 'OBSERVED', plainIssue: 'Claims 24/7, lists weekday hours only',
                          url: `https://mcr-plumbing.test/${n}`, quote: '24/7 emergency plumber ... Mon-Fri 8-5', confidence: 'MEDIUM' } }
          : { snapshotId: snap, ruleKey: 'check.website_presence', checkCode: 'presence.website', state: 'OBSERVED', result: 'gap',
              evidence: { issueCode: 'E-NO-WEBSITE', claimState: 'OBSERVED', plainIssue: 'The business listing shows no website',
                          url: `https://directory.test/mcr/${n}`, quote: 'Website: (none listed)', confidence: 'MEDIUM' } });
        const id = await rec.recordOpportunity(db(), { businessId, opportunityType: site ? 'after_hours_gap' : 'no_website', evidenceIds: [f.evidenceId!],
          catalogKey: site ? 'lead_recovery_system' : 'website_build', servicePrice: site ? 350 : undefined, currency: site ? 'GBP' : undefined });
        await db().query('UPDATE opportunities SET search_run_id = $2 WHERE id = $1', [id, runId]);
        await concludeAnalysis(db(), runId, businessId, T(2));
        opps.push({ id, businessId, path: site ? 'FIX' : 'WEBSITE', evidenceId: f.evidenceId!, checkCode: site ? 'trades.24_7_claim' : 'presence.website',
                    ruleId: site ? hours : presence });
      }
      void websiteBuild;

      // One opportunity system: both paths in the same feed, filterable.
      const feed = await listOpportunities(db(), { searchRunId: runId, limit: 500 });
      const websiteCount = opps.filter((o) => o.path === 'WEBSITE').length, fixCount = opps.filter((o) => o.path === 'FIX').length;
      expect(websiteCount).toBeGreaterThan(0);
      expect(fixCount).toBeGreaterThan(0);
      expect(feed.length).toBe(websiteCount + fixCount);
      expect((await listOpportunities(db(), { paths: ['WEBSITE'], limit: 500 })).every((o) => o.kind === 'website' && o.service.price === null)).toBe(true);
      expect((await listOpportunities(db(), { kinds: ['lead_recovery'], employeeMin: 5, employeeMax: 30, revenueMin: 250_000, revenueMax: 5_000_000,
        revenueCurrency: 'GBP', limit: 500 })).length).toBe(fixCount);
      expect(await listOpportunities(db(), { revenueMin: 1, revenueCurrency: 'CAD' })).toEqual([]);

      // WEBSITE path: build website -> demo -> sell. FIX path: evidence -> lead recovery -> build fix -> demo -> sell.
      const web = opps.find((o) => o.path === 'WEBSITE')!, fix = opps.find((o) => o.path === 'FIX')!;
      for (const o of [web, fix]) {
        const input = await loadBuildInput(db(), o.id);
        expect(input.evidence.map((e) => e.id)).toEqual([o.evidenceId]);   // the build cites the opportunity's evidence
        const demo = await recordBuild(db(), input, { title: 'Demo', summary: 'What the fix looks like', artifactRef: `demo/${o.id}` },
          { purpose: 'DEMO', generator: 'operator' });
        await approveBuild(db(), demo, 'owner', T(3));
        await markBuildShown(db(), demo, T(4));
        // A demo is not delivery, and a delivery build needs a win.
        expect(await refused(db(), () => recordBuild(db(), input, { title: 'Delivery', summary: 's', artifactRef: 'x' }, { purpose: 'DELIVERY', generator: 'operator' })))
          .toMatch(/DELIVERY build needs a won opportunity/);
      }
      const shown = await listOpportunities(db(), { buildStates: ['DEMO_SHOWN'] });
      expect(shown.map((o) => o.opportunityId).sort()).toEqual([web.id, fix.id].map(String).sort());
      let summary = (await getSearchRunSummary(db(), runId))!;
      expect(summary.revenue).toBeNull();   // demos shown, nothing sold: no revenue

      for (const [o, amount] of [[fix, 350], [web, 900]] as const) {
        const contact = await rec.recordContact(db(), { businessId: o.businessId, fullName: 'Owner', email: `owner-${o.id}@prospect.test`,
          source: 'companies_house_officer', label: 'PUBLICLY_FOUND', outreachBasis: 'corporate_subscriber' });
        const msg = await rec.recordMessage(db(), { opportunityId: o.id, contactId: contact, subject: 's', body: 'b', evidenceIds: [o.evidenceId], mailboxConnectionId: mailbox });
        await rec.approveMessage(db(), msg, 'owner', T(5));
        await rec.markMessageSent(db(), msg, T(6));
        await rec.recordOutcome(db(), { opportunityId: o.id, kind: 'pitched', occurredAt: T(6), messageId: msg, recordedBy: 'owner' });
        await rec.recordOutcome(db(), { opportunityId: o.id, kind: 'won', occurredAt: T(30), amount, currency: 'GBP', recordedBy: 'owner' });
        const delivery = await recordBuild(db(), await loadBuildInput(db(), o.id), { title: 'Delivered', summary: 'Live', artifactRef: `live/${o.id}` },
          { purpose: 'DELIVERY', generator: 'operator' });
        await approveBuild(db(), delivery, 'owner', T(40));
        await rec.recordOutcome(db(), { opportunityId: o.id, kind: 'delivered', occurredAt: T(48), deliveredBy: 'operator', recordedBy: 'owner' });
        // VERIFY: the same check on a later snapshot now passes.
        const later = await rec.recordSnapshot(db(), { businessId: o.businessId, url: 'https://verified.test/', fetchedAt: T(72), fetchMethod: 'manual' });
        const ok = await rec.recordFinding(db(), { snapshotId: later, ruleKey: o.path === 'FIX' ? 'check.trades_hours_and_routes' : 'check.website_presence',
          checkCode: o.checkCode, state: 'OBSERVED', result: 'ok' });
        await db().query(`INSERT INTO verifications (opportunity_id, baseline_evidence_id, snapshot_id, observation_id, rule_version_id, status, verified_at)
          VALUES ($1, $2, $3, $4, $5, 'PASSED', $6)`, [o.id, o.evidenceId, later, ok.observationId, o.ruleId, T(72)]);
      }
      const done = await listOpportunities(db(), { sellStates: ['WON'] });
      expect(done.map((o) => [o.path, o.deliveryState, o.dealValue]).sort()).toEqual([['FIX', 'VERIFIED_PASSED', '350.00'], ['WEBSITE', 'VERIFIED_PASSED', '900.00']]);

      summary = (await getSearchRunSummary(db(), runId))!;
      expect(summary.counts).toMatchObject({ discovered: 200, qualified: 100, rejected: 80, needsReview: 20, selected: 50, analyzed: 50,
        opportunities: websiteCount + fixCount, websiteOpportunities: websiteCount, fixOpportunities: fixCount, pitched: 2, wins: 2 });
      expect(summary.credits).toEqual({ consumed: '400.0000', estimatedPending: '0', remaining: '0.0000' });
      expect(summary.analysisCost).toEqual({ amount: '1.0000', currency: 'GBP' });
      expect([summary.revenue, summary.revenuePer100Discovered, summary.revenuePer100Analyzed]).toEqual(['1250.00', '625.00', '2500.00']);
      expect((await getSearchPerformance(db(), searchId))[0]).toMatchObject({ runs: 1, discovered: 200, wins: 2, revenue: '1250.00', creditsConsumed: '400.0000' });
      return { runId, searchId, businessId: web.businessId, opp: web.id, mailbox };
    });

    // ---------------------------------------------------------------- User B
    await withWorkspace(db(), b.workspaceId, async () => {
      await registerManualMailbox(db(), { provider: 'microsoft_365', email: 'founder@seller-b.test' });
      const searchId = await createSearch(db(), { name: 'Toronto Dental Clinics', countryCode: 'CA', city: 'Toronto', subverticals: ['dental'],
        employeeMin: 10, employeeMax: 100, revenueMin: 1_000_000, revenueMax: 10_000_000, revenueCurrency: 'CAD', opportunityKinds: ['booking_flow'] });
      const runId = await startSearchRun(db(), searchId);
      // Even a business with the same domain as one of User A's is User B's own, separate row.
      const same = await recordDiscoveredBusiness(db(), runId, { source: { provider: 'csv', sourceType: 'csv_import', reference: 'b.csv:1' },
        name: 'Toronto Smiles', domain: 'mcr-plumbing-2.test', city: 'Toronto', countryCode: 'CA', subvertical: 'dental',
        employees: { count: 25, basis: 'VERIFIED', source: 'register', asOf: T(0) },
        revenue: { amount: 3_000_000, currency: 'CAD', basis: 'REPORTED', source: 'owner', asOf: T(0) } });
      expect(same.matchedBy).toBe('new');
      expect(await prequalifyRun(db(), runId, new Date(T(1)))).toEqual({ qualified: 1, rejected: 0, needsReview: 0 });
    });

    // Acting as the application role, as a real request would, User B sees only User B's data.
    await asApp(db(), b.workspaceId, async () => {
      expect(await getSearchRunSummary(db(), A.runId)).toBeNull();
      expect(await getBusinessDetail(db(), A.businessId)).toBeNull();
      expect(await listOpportunities(db(), { limit: 500 })).toEqual([]);
      expect(await getSearchPerformance(db())).toMatchObject([{ name: 'Toronto Dental Clinics', discovered: 1 }]);
      expect((await listMapBusinesses(db())).length).toBe(0);   // B recorded no coordinates
      expect((await listMailboxes(db())).map((m) => m.email)).toEqual(['founder@seller-b.test']);
      for (const t of ['businesses', 'contacts', 'messages', 'cost_events', 'opportunities', 'searches', 'search_runs', 'builds', 'outcomes']) {
        const r = await one<{ n: string }>(db(), `SELECT count(*) AS n FROM ${t} WHERE workspace_id = $1`, [a.workspaceId]);
        expect(r.n, t).toBe('0');
      }
      expect((await db().query('SELECT name FROM businesses')).rows.map((r) => r.name)).toEqual(['Toronto Smiles']);
    });
    // And User A, likewise, sees none of User B's.
    await asApp(db(), a.workspaceId, async () => {
      expect((await getSearchPerformance(db())).map((s) => s.name)).toEqual(['Manchester Plumbers']);
      expect((await listMailboxes(db())).map((m) => m.email)).toEqual(['hello@seller-a.test']);
      // Every fixture business sits within about 2 km of this point; the map returns only A's.
      expect((await listMapBusinesses(db(), { near: { latitude: 53.48, longitude: -2.24, radiusKm: 5 } })).length).toBe(200);
      // Fixture latitudes are 53.48 + i / 10000, so this box holds i = 0..100.
      expect((await listMapBusinesses(db(), { bounds: { north: 53.49, south: 53.47, east: -2.2, west: -2.3 } })).length).toBe(101);
      const withOpps = (await listMapBusinesses(db(), { city: 'Manchester' })).filter((p) => p.opportunities > 0);
      expect(new Set(withOpps.flatMap((p) => p.opportunityPaths))).toEqual(new Set(['WEBSITE', 'FIX']));
    });
  });
});
