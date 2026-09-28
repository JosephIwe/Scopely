// Fixtures for the website build kind: a workspace-owned "website" service (the starter catalog
// has none, and its price stays unknown), a business with withheld facts, a NOT_OBSERVABLE
// observation, and an opportunity mapped to that service.
import type pg from 'pg';
import { MemoryObjectStore } from '../src/storage/index.js';
import { one, seedChain } from './helpers.js';

/** A 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const SIGNING_KEY = 'test-preview-signing-key-0123456789abcdef';

export async function seedWebsiteOpportunity(db: pg.Client, opts: { reviews?: boolean; issue?: string } = {}) {
  const c = await seedChain(db);
  // Facts the builder must not use: recorded without a source or basis (withheld), or private.
  await db.query(`UPDATE businesses SET phone = '+44 20 7946 0999', address_line = '12 Hidden Street', postal_code = 'ZZ1 1ZZ',
                  revenue_amount = 950000, revenue_currency = 'GBP', revenue_basis = 'ESTIMATED', revenue_source = 'model', revenue_as_of = '2026-09-01'
                  WHERE id = $1`, [c.businessId]);
  if (opts.reviews) {
    await db.query(`UPDATE businesses SET review_count = 132, rating = 4.8, reviews_source = 'google_places', reviews_as_of = '2026-09-20' WHERE id = $1`, [c.businessId]);
  }
  // Something that could not be observed: the booking path.
  const rule = await one<{ id: string }>(db, `SELECT id FROM rule_versions WHERE rule_key = 'check.booking_cta_trace' AND version = 1`);
  await db.query(`INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, observed_at)
                  VALUES ($1, 'booking_cta_trace.path', $2, 'NOT_OBSERVABLE', '2026-09-28T10:00:00Z')`, [c.snapshotId, rule.id]);
  const cat = (await db.query<{ id: string }>(`SELECT id FROM catalog_items WHERE key = 'website_build' AND workspace_id = scopely.current_workspace_id()`)).rows[0]
    ?? await one<{ id: string }>(db,
    `INSERT INTO catalog_items (workspace_id, key, service, description, build_kind, supported_issue_codes)
     VALUES (scopely.current_workspace_id(), 'website_build', 'Website build', 'A new website for a business. Price not established.', 'website',
             ARRAY['E-LINK-TARGET-MISMATCH','E-BOOK-TO-ENQUIRY','E-NO-NEXT-STEP']) RETURNING id`);
  const opp = await one<{ id: string }>(db,
    `INSERT INTO opportunities (business_id, market_id, opportunity_type, mapping_status, catalog_item_id)
     VALUES ($1, $2, 'website_rebuild', 'MAPPED', $3) RETURNING id`, [c.businessId, c.marketId, cat.id]);
  await db.query('INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1, $2)', [opp.id, c.evidenceId]);
  return { ...c, catalogItemId: cat.id, opportunityId: opp.id };
}

/** Records a confirmed re-check of the seeded evidence, so an approved demo may be shown. */
export async function confirmRecheck(db: pg.Client, c: { businessId: string; evidenceId: string; ruleId: string }, at = '2026-10-01T09:00:00Z') {
  const s = await one<{ id: string }>(db, `INSERT INTO snapshots (business_id, url, fetched_at, fetch_method) VALUES ($1, 'https://example-clinic.test/', $2, 'manual') RETURNING id`, [c.businessId, at]);
  const o = await one<{ id: string }>(db, `INSERT INTO observations (snapshot_id, check_code, rule_version_id, state, result) VALUES ($1, 'contact_links.whatsapp', $2, 'OBSERVED', 'defect') RETURNING id`, [s.id, c.ruleId]);
  await db.query(`INSERT INTO evidence_rechecks (evidence_id, snapshot_id, observation_id, result, recorded_by) VALUES ($1,$2,$3,'confirmed','operator')`, [c.evidenceId, s.id, o.id]);
}

export const newStore = () => new MemoryObjectStore();
