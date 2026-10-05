// A prospect lookup (Slice 12): for one opportunity of the current workspace, ask a prospect
// intelligence provider who works at the business, and keep what it said with where and when it
// said it.
//
//   OPPORTUNITY -> BUSINESS IDENTITY -> PROVIDER (through the gateway) -> PEOPLE + FACTS -> contacts / contact_facts
//
// Truth rules held here and again by the database (migration 016):
// - A person or fact a provider returned is stored UNVERIFIED, with the provider call that returned
//   it. It is never a decision maker, never given a relationship, never given a lawful basis.
// - A repeat is not a new person. The same provider id, the same LinkedIn profile or the same name
//   at the same business is the person already on file; what the provider said is added beside
//   what was there, never over it, so two sources that disagree stay visible as a conflict.
// - Nothing found is recorded as a successful call with no result. It is not evidence that the
//   business has no such person.
// - A business on the workspace's suppression list is not looked up at all.
// - A failure stores nothing but the call's own ledger row.
//
// Logs and errors carry ids only, never names, addresses or numbers.
import type { SecretResolver } from '../build/agents.js';
import type { Db } from '../tenancy/index.js';
import {
  type CallCredential, type GatewayOptions, PROVIDER_ERROR_WORDS, type ProviderErrorCode, callProvider, connectionCredential,
} from '../providers/gateway.js';
import { PROSPECT_PEOPLE_CEILING, type PeopleResult, type ProspectProviderRegistry, type ProviderFact } from '../providers/prospects.js';
import { nameKey, normalizeFact } from './facts.js';

export class ProspectLookupRefused extends Error {
  constructor(readonly reason: 'not_found' | 'no_provider' | 'suppressed' | 'not_searchable' | 'not_connected', message: string) { super(message); }
}

/** What a person sees when a lookup fails: the gateway's words, in a lookup's terms where they differ. */
export const LOOKUP_ERROR_WORDS: Record<ProviderErrorCode, string> = {
  ...PROVIDER_ERROR_WORDS,
  invalid_request: 'The provider could not look up this business.',
  not_recorded: 'No recorded provider response exists for this business. Recorded mode only replays lookups that were recorded.',
};

export interface ProspectLookupDeps extends GatewayOptions {
  providers: ProspectProviderRegistry;
  secrets?: SecretResolver;
}

export interface LookupConflict { contactId: string; kind: string; values: string[] }

export interface ProspectLookupResult {
  provider: string;
  transport: 'live' | 'recorded';
  operationId: string;
  /** People the provider returned (after removing repeats within the answer). */
  returned: number;
  /** People added to this business. */
  added: number;
  /** Returned people who were already on file (same provider id, LinkedIn profile or name). */
  matched: number;
  /** Repeats inside the provider's own answer. */
  repeated: number;
  factsAdded: number;
  /** Values that were not what their kind says and were dropped (an address that is not an address). */
  factsRejected: number;
  conflicts: LookupConflict[];
  error: { code: ProviderErrorCode; message: string } | null;
}

async function caseBusiness(db: Db, opportunityId: string) {
  const r = (await db.query(
    `SELECT o.id AS opportunity_id, b.id AS business_id, b.name, b.domain, b.country_code
       FROM scopely.opportunities o JOIN scopely.businesses b ON b.id = o.business_id
      WHERE o.id = $1 AND o.workspace_id = scopely.current_workspace_id() AND b.workspace_id = scopely.current_workspace_id()`,
    [opportunityId])).rows[0];
  if (!r) throw new ProspectLookupRefused('not_found', 'That opportunity does not exist.');
  return r as { opportunity_id: string; business_id: string; name: string; domain: string | null; country_code: string | null };
}

/** True when this workspace's suppression list covers the business itself or its domain. */
export async function businessSuppressed(db: Db, businessId: string, domain: string | null): Promise<boolean> {
  return Boolean((await db.query(
    `SELECT 1 FROM scopely.suppression WHERE workspace_id = scopely.current_workspace_id()
        AND (business_id = $1 OR (domain IS NOT NULL AND lower(domain) = lower(coalesce($2, '')))) LIMIT 1`, [businessId, domain])).rows[0]);
}

/**
 * Looks up the people at one opportunity's business through a prospect provider and stores what it
 * returned. Refuses (ProspectLookupRefused) before any call when the lookup cannot or must not run.
 */
export async function runProspectLookup(db: Db, deps: ProspectLookupDeps, opportunityId: string, providerKey: string): Promise<ProspectLookupResult> {
  const biz = await caseBusiness(db, opportunityId);
  const provider = deps.providers.get(providerKey);
  if (!provider) throw new ProspectLookupRefused('no_provider', `No prospect provider ${providerKey} is available.`);
  if (await businessSuppressed(db, biz.business_id, biz.domain)) {
    throw new ProspectLookupRefused('suppressed', 'This business is on your suppression list, so Scopely does not look up its people.');
  }
  const records = (await db.query(
    `SELECT provider_record FROM scopely.sources WHERE business_id = $1 AND workspace_id = scopely.current_workspace_id()
        AND provider = $2 AND provider_record IS NOT NULL ORDER BY id`, [biz.business_id, provider.provider])).rows.map((r) => r.provider_record as Record<string, unknown>);
  const planned = provider.plan({ businessName: biz.name, domain: biz.domain, countryCode: biz.country_code, providerRecords: records });
  if ('refused' in planned) throw new ProspectLookupRefused('not_searchable', planned.refused);

  let credential: CallCredential | null = null;
  if (provider.transport === 'live') {
    credential = await connectionCredential(db, provider.provider, 'prospects', deps.secrets);
    if (!credential) throw new ProspectLookupRefused('not_connected', `Connect this workspace’s ${provider.label} account for prospect lookups first.`);
  }

  const call = await callProvider<PeopleResult>(db, {
    provider: provider.provider, capability: 'prospect_intelligence', operation: 'find_people', transport: provider.transport, credential,
    request: planned.request, businessId: biz.business_id, opportunityId: biz.opportunity_id,
  }, async () => {
    const r = await provider.findPeople(planned.request, credential);
    return { value: r, ref: r.ref, resultCount: r.people.length, cost: r.cost ?? null };
  }, deps);

  const out: ProspectLookupResult = {
    provider: provider.provider, transport: provider.transport, operationId: call.operationId, returned: 0, added: 0, matched: 0, repeated: 0,
    factsAdded: 0, factsRejected: 0, conflicts: [], error: null,
  };
  if (!call.result.ok) {
    out.error = { code: call.result.error.code, message: LOOKUP_ERROR_WORDS[call.result.error.code] };
    return out;
  }
  await storePeople(db, biz.business_id, provider.provider, call.operationId, call.result.value, out);
  return out;
}

type Existing = { id: string; full_name: string | null; source: string; provider_person_ref: string | null };

async function storePeople(db: Db, businessId: string, provider: string, operationId: string, r: PeopleResult, out: ProspectLookupResult) {
  const existing = (await db.query<Existing>(
    `SELECT id, full_name, source, provider_person_ref FROM scopely.contacts WHERE business_id = $1 AND workspace_id = scopely.current_workspace_id() ORDER BY id`,
    [businessId])).rows;
  const profiles = (await db.query<{ contact_id: string; value: string }>(
    `SELECT contact_id, value FROM scopely.contact_facts WHERE business_id = $1 AND workspace_id = scopely.current_workspace_id()
        AND kind = 'linkedin' AND contact_id IS NOT NULL`, [businessId])).rows;
  const seen = new Set<string>();
  const touched = new Set<string>();

  for (const p of r.people) {
    if (seen.has(p.ref)) { out.repeated += 1; continue; }
    seen.add(p.ref);
    if (out.returned >= PROSPECT_PEOPLE_CEILING) break;
    out.returned += 1;
    const facts = normalized(p.facts, out);
    const profile = facts.find((f) => f.kind === 'linkedin')?.value ?? null;
    const key = nameKey(p.fullName);
    // The person already on file: same provider id, then same profile, then the only contact with the same name.
    const byRef = existing.find((c) => c.source === provider && c.provider_person_ref === p.ref);
    const byProfile = profile ? profiles.find((x) => x.value === profile) : undefined;
    const byName = key ? existing.filter((c) => nameKey(c.full_name) === key) : [];
    const matchId = byRef?.id ?? byProfile?.contact_id ?? (byName.length === 1 ? byName[0]!.id : null);
    let contactId: string;
    if (matchId) {
      contactId = String(matchId);
      out.matched += 1;
    } else {
      if (!p.fullName) continue;   // a provider person with no name is nobody Scopely can name
      contactId = String((await db.query(
        `INSERT INTO scopely.contacts (business_id, full_name, role, is_decision_maker, source, label, outreach_basis, observed_at, confidence,
           provider_operation_id, provider_record, provider_person_ref)
         VALUES ($1, $2, $3, false, $4, 'UNVERIFIED', 'unknown', $5, $6, $7, $8, $9) RETURNING id`,
        [businessId, p.fullName.slice(0, 120), p.title?.slice(0, 120) ?? null, provider, r.observedAt, p.confidence ?? null, operationId,
         JSON.stringify(p.record), p.ref])).rows[0].id);
      existing.push({ id: contactId, full_name: p.fullName, source: provider, provider_person_ref: p.ref });
      out.added += 1;
    }
    touched.add(contactId);
    for (const f of facts) out.factsAdded += await insertFact(db, businessId, contactId, provider, operationId, r.observedAt, f);
  }
  for (const f of normalized(r.businessFacts.filter((x) => x.kind !== 'title'), out)) {
    out.factsAdded += await insertFact(db, businessId, null, provider, operationId, r.observedAt, f);
  }
  out.conflicts = await conflictsFor(db, [...touched]);
}

function normalized(facts: ProviderFact[], out: ProspectLookupResult): (ProviderFact & { value: string })[] {
  const keep: (ProviderFact & { value: string })[] = [];
  for (const f of facts) {
    const value = normalizeFact(f.kind, f.value);
    const sourceUrl = f.sourceUrl ? normalizeFact('contact_page', f.sourceUrl) : null;
    if (value === null) { out.factsRejected += 1; continue; }
    keep.push({ ...f, value, sourceUrl });
  }
  return keep;
}

async function insertFact(db: Db, businessId: string, contactId: string | null, provider: string, operationId: string, observedAt: string,
  f: ProviderFact & { value: string }): Promise<number> {
  const r = await db.query(
    `INSERT INTO scopely.contact_facts (business_id, contact_id, kind, value, source, source_url, observed_at, label, confidence, provider_operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'UNVERIFIED', $8, $9)
     ON CONFLICT (workspace_id, business_id, coalesce(contact_id, 0), kind, lower(value), lower(source)) DO NOTHING RETURNING id`,
    [businessId, contactId, f.kind, f.value, provider, f.sourceUrl ?? null, observedAt, f.confidence ?? null, operationId]);
  return r.rowCount ?? 0;
}

/** Kinds a person can have only one of, where two different values from the record mean the sources disagree. */
export const SINGLE_VALUED: readonly string[] = ['title', 'linkedin', 'instagram', 'x'];

/** For each contact, the single-valued kinds its sources disagree on, including a recorded role that differs from a reported title. */
export async function conflictsFor(db: Db, contactIds: string[]): Promise<LookupConflict[]> {
  if (!contactIds.length) return [];
  const rows = (await db.query<{ contact_id: string; kind: string; values: string[] }>(
    `SELECT f.contact_id, f.kind, array_agg(DISTINCT f.value ORDER BY f.value) AS values
       FROM (SELECT contact_id, kind, value FROM scopely.contact_facts
              WHERE contact_id = ANY ($1) AND workspace_id = scopely.current_workspace_id() AND kind = ANY ($2)
             UNION ALL
             -- A role a person recorded is a title from another source.
             SELECT c.id, 'title', c.role FROM scopely.contacts c
              WHERE c.id = ANY ($1) AND c.workspace_id = scopely.current_workspace_id() AND c.role IS NOT NULL AND c.provider_operation_id IS NULL) f
      GROUP BY f.contact_id, f.kind
     HAVING count(DISTINCT lower(f.value)) > 1
      ORDER BY f.contact_id, f.kind`, [contactIds, SINGLE_VALUED])).rows;
  return rows.map((r) => ({ contactId: String(r.contact_id), kind: r.kind, values: r.values }));
}
