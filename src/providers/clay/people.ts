// ClayProspectAdapter: the ProspectIntelligenceProvider capability, backed by Clay's people search
// (search-contacts: people currently at a company, by role). Clay concepts stop here.
//
// What is taken from a Clay person: their name, the title Clay reports, and their LinkedIn profile.
// Nothing else is inferred from it. Clay documents email addresses as a separate enrichment of a
// search's people (add-contact-data-points), which uses Clay credits; this adapter does not call it
// (see the Slice 12 report: it needs a founder decision on who pays). Clay states no confidence for a person, so
// confidence stays not stated, and it reports no cost for a search, so the cost is NOT_REPORTED.
//
// The people fixture this adapter is tested against is synthetic (fixtures/providers/clay): it
// follows the company search page Clay was recorded returning (taskId, an entity map keyed by
// entityId, order, timestampMs), but a live people search has not been run from Scopely yet, so the
// field names below are read defensively and a page without them is a malformed response.
import { ProviderError } from '../gateway.js';
import type { CallCredential } from '../gateway.js';
import type { FactKind, PeopleResult, ProspectIntelligenceProvider, ProspectQuery, ProviderPerson } from '../prospects.js';
import { PROSPECT_PEOPLE_CEILING } from '../prospects.js';
import type { ClayTransport } from './transport.js';

/** The roles that usually buy website work for a small business. A filter on Clay's side only: a title is never a decision. */
export const CLAY_BUYER_TITLES = ['Owner', 'Founder', 'Director', 'Managing Director', 'Partner', 'Practice Manager', 'Marketing Manager'] as const;
export const CLAY_PEOPLE_QUERY =
  `select from people where experiences.any(is_current = true and job_title is_similar_to (${CLAY_BUYER_TITLES.map((t) => `"${t}"`).join(', ')})) limit ${PROSPECT_PEOPLE_CEILING}`;

/** The fields Scopely keeps from a Clay person, as Clay named them. */
const KEPT = ['entityId', 'name', 'full_name', 'title', 'job_title', 'latest_experience_title', 'url', 'linkedin_url', 'location', 'locality', 'domain', 'order'] as const;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A Clay person in Scopely's words, or null for a record without an id. */
export function normalizeClayPerson(raw: unknown): ProviderPerson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const ref = str(p.entityId);
  if (!ref) return null;
  const record: Record<string, unknown> = {};
  for (const k of KEPT) if (p[k] !== undefined && p[k] !== null) record[k] = p[k];
  const fullName = str(p.full_name) ?? str(p.name);
  const title = str(p.job_title) ?? str(p.title) ?? str(p.latest_experience_title);
  const profile = str(p.linkedin_url) ?? str(p.url);
  const facts: ProviderPerson['facts'] = [];
  if (title) facts.push({ kind: 'title', value: title });
  if (profile) facts.push({ kind: 'linkedin', value: profile });
  return { ref: `person:${ref}`, fullName, title, confidence: null, facts, record };
}

export class ClayProspectAdapter implements ProspectIntelligenceProvider {
  readonly provider = 'clay';
  readonly label = 'Clay';
  readonly transport: 'live' | 'recorded';
  readonly kinds: readonly FactKind[] = ['title', 'linkedin'];

  constructor(private readonly t: ClayTransport, private readonly now: () => Date = () => new Date()) {
    this.transport = t.kind;
  }

  plan(q: ProspectQuery): { request: Record<string, unknown> } | { refused: string } {
    // The company Clay itself returned earlier, when it did: its profile identifies it exactly.
    const profile = q.providerRecords.map((r) => str(r.url)).find((u) => u && /linkedin\.com\/company\//i.test(u)) ?? null;
    const ids = [q.domain, profile].filter((x): x is string => Boolean(x));
    if (!ids.length) return { refused: 'Scopely needs the business’s domain to look up its people. A name alone could match another business.' };
    return { request: { companyIdentifiers: ids, dsl: CLAY_PEOPLE_QUERY } };
  }

  async findPeople(request: Record<string, unknown>, credential: CallCredential | null): Promise<PeopleResult> {
    const ids = (request.companyIdentifiers as string[]) ?? [];
    const dsl = String(request.dsl);
    const raw = credential ? await credential.withSecret((s) => this.t.searchPeople(ids, dsl, s)) : await this.t.searchPeople(ids, dsl, null);
    const page = raw as { taskId?: unknown; people?: unknown; contacts?: unknown; timestampMs?: unknown };
    const map = page && typeof page === 'object' ? (page.people ?? page.contacts) : undefined;
    if (!page || typeof page.taskId !== 'string' || !page.taskId || !map || typeof map !== 'object' || Array.isArray(map)) {
      throw new ProviderError('malformed_response', 'the people search result is missing taskId or people');
    }
    const observedAt = (typeof page.timestampMs === 'number' && Number.isFinite(page.timestampMs) ? new Date(page.timestampMs) : this.now()).toISOString();
    const rows = Object.values(map as Record<string, unknown>)
      .sort((a, b) => Number((a as { order?: number })?.order ?? 0) - Number((b as { order?: number })?.order ?? 0));
    const people = rows.map(normalizeClayPerson).filter((x): x is ProviderPerson => x !== null);
    return { people, businessFacts: [], observedAt, ref: page.taskId, cost: null };
  }
}
