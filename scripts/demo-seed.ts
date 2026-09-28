// Seeds a local database with one sample workspace and one sample website opportunity, so the
// Build Workspace can be tried end to end. Everything it writes is sample data for a fictional
// business on a reserved .example domain; never run it against a real workspace.
//
//   DATABASE_URL=... pnpm demo:seed     # prints the workspace id to pass to `pnpm serve`
import { connect } from '../src/db/client.js';
import { createWorkspace, withWorkspace } from '../src/tenancy/index.js';

const db = await connect();
try {
  await db.query('BEGIN');
  const { workspaceId } = await createWorkspace(db, { slug: `sample-${Date.now().toString(36)}`, name: 'Sample workspace' });
  await withWorkspace(db, workspaceId, async () => {
    const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
    const biz = await q(`INSERT INTO scopely.businesses (name, domain, website_url, review_count, rating, reviews_source, reviews_as_of, phone, city)
      VALUES ('Alder & Finch Physiotherapy', 'alderfinch.example', 'https://alderfinch.example/', 87, 4.9, 'google_places', '2026-09-20', '+44 20 7946 0123', 'Sampleton')
      RETURNING id`);
    const snap = await q(`INSERT INTO scopely.snapshots (business_id, url, http_status, fetched_at, fetch_method, viewport, html_sha256)
      VALUES ($1, 'https://alderfinch.example/', 200, '2026-09-27T09:00:00Z', 'render', 'mobile', repeat('b', 64)) RETURNING id`, [biz.id]);
    const rule = await q(`SELECT id FROM scopely.rule_versions WHERE rule_key = 'check.booking_cta_trace' AND version = 1`);
    const obs = await q(`INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, observed_at)
      VALUES ($1, 'booking_cta_trace.target', $2, 'OBSERVED', 'defect', '/contact', 'Book an appointment', '2026-09-27T09:00:00Z') RETURNING id`, [snap.id, rule.id]);
    const ev = await q(`INSERT INTO scopely.evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, observed_at, confidence)
      VALUES ($1, $2, 'E-BOOK-TO-ENQUIRY', $3, 'OBSERVED', 'The "Book an appointment" button opens a general enquiry form, not a booking',
              'https://alderfinch.example/', '<a class="btn" href="/contact">Book an appointment</a>', '2026-09-27T09:00:00Z', 'MEDIUM') RETURNING id`,
      [biz.id, obs.id, rule.id]);
    await q(`INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, observed_at)
      VALUES ($1, 'booking_platform_fingerprint.platform', (SELECT id FROM scopely.rule_versions WHERE rule_key = 'check.booking_platform_fingerprint' AND version = 1),
              'NOT_OBSERVABLE', '2026-09-27T09:00:00Z') RETURNING id`, [snap.id]);
    const cat = await q(`INSERT INTO scopely.catalog_items (workspace_id, key, service, description, build_kind, supported_issue_codes)
      VALUES ($1, 'website_build', 'Website build', 'A new website for a business. Price not established.', 'website',
              ARRAY['E-BOOK-TO-ENQUIRY','E-NO-NEXT-STEP','E-CTA-DEAD-END']) RETURNING id`, [workspaceId]);
    const opp = await q(`INSERT INTO scopely.opportunities (business_id, opportunity_type, mapping_status, catalog_item_id)
      VALUES ($1, 'website_rebuild', 'MAPPED', $2) RETURNING id`, [biz.id, cat.id]);
    await q('INSERT INTO scopely.opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2) RETURNING opportunity_id', [opp.id, ev.id]);
  });
  await db.query('COMMIT');
  console.log(workspaceId);
} finally {
  await db.end();
}
