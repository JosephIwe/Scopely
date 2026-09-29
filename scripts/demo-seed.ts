// Seeds a local database with one sample workspace, one sample website opportunity and one sample
// fix opportunity (a broken WhatsApp link), so the Build Workspace and the Fix Builder can be tried
// end to end. The fix business's page is served from fixtures/demo-pages by `pnpm serve`, because
// a reserved .example domain can never be fetched. Everything it writes is sample data for a fictional
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
    // A sample buyer contact for the Case File (Slice 8). Its outreach basis is unknown, so the
    // database's own gate says it may not be emailed, which the Case File shows.
    await q(`INSERT INTO scopely.contacts (business_id, full_name, role, is_decision_maker, email, email_kind, source, source_url, label, outreach_basis)
      VALUES ($1, 'Sam Alder', 'Practice manager', true, 'sam@alderfinch.example', 'role', 'website_contact_page', 'https://alderfinch.example/contact',
              'PUBLICLY_FOUND', 'unknown') RETURNING id`, [biz.id]);

    // A fix opportunity: a WhatsApp button whose number has no country code (E-WA-BROKEN), sold as
    // the shared starter Website Fix Sprint.
    const fixBiz = await q(`INSERT INTO scopely.businesses (name, domain, website_url) VALUES ('Harbour Lane Dental', 'harbourlane.example', 'https://harbourlane.example/')
      RETURNING id`);
    const links = await q(`SELECT id FROM scopely.rule_versions WHERE rule_key = 'check.contact_links' AND version = 1`);
    const fixSnap = await q(`INSERT INTO scopely.snapshots (business_id, url, http_status, fetched_at, fetch_method, viewport, html_sha256)
      VALUES ($1, 'https://harbourlane.example/contact', 200, '2026-09-26T10:00:00Z', 'render', 'mobile', repeat('c', 64)) RETURNING id`, [fixBiz.id]);
    const fixObs = await q(`INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, href, visible_text, observed_at)
      VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect', 'https://api.whatsapp.com/send?phone=07700900461', 'WhatsApp us', '2026-09-26T10:00:00Z')
      RETURNING id`, [fixSnap.id, links.id]);
    const fixEv = await q(`INSERT INTO scopely.evidence (business_id, observation_id, issue_code, rule_version_id, claim_state, plain_issue, url, quote, observed_at, confidence)
      VALUES ($1, $2, 'E-WA-BROKEN', $3, 'OBSERVED', 'The "WhatsApp us" button uses a number with no country code, which WhatsApp cannot open',
              'https://harbourlane.example/contact', '<a class="wa" href="https://api.whatsapp.com/send?phone=07700900461">WhatsApp us</a>',
              '2026-09-26T10:00:00Z', 'HIGH') RETURNING id`, [fixBiz.id, fixObs.id, links.id]);
    // HIGH evidence is re-checked on a later visit before anything reaches the prospect (sample re-check).
    const reSnap = await q(`INSERT INTO scopely.snapshots (business_id, url, http_status, fetched_at, fetch_method) VALUES ($1, 'https://harbourlane.example/contact', 200,
      '2026-09-27T10:00:00Z', 'manual') RETURNING id`, [fixBiz.id]);
    const reObs = await q(`INSERT INTO scopely.observations (snapshot_id, check_code, rule_version_id, state, result, observed_at)
      VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect', '2026-09-27T10:00:00Z') RETURNING id`, [reSnap.id, links.id]);
    await q(`INSERT INTO scopely.evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1, $2, $3, 'confirmed', 'sample') RETURNING id`,
      [fixEv.id, reSnap.id, reObs.id]);
    const sprint = await q(`SELECT id FROM scopely.catalog_items WHERE key = 'website_fix_sprint' AND workspace_id IS NULL`);
    const fixOpp = await q(`INSERT INTO scopely.opportunities (business_id, opportunity_type, mapping_status, catalog_item_id, currency, service_price)
      VALUES ($1, 'broken_contact_path', 'MAPPED', $2, 'GBP', 120) RETURNING id`, [fixBiz.id, sprint.id]);
    await q('INSERT INTO scopely.opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2) RETURNING opportunity_id', [fixOpp.id, fixEv.id]);
  });
  await db.query('COMMIT');
  console.log(workspaceId);
} finally {
  await db.end();
}
