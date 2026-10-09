// Prospect intelligence through a provider (Slice 12): BUSINESS -> PEOPLE -> CONTACT CHANNELS ->
// PROVENANCE. The capability Scopely's domain depends on; an adapter (src/providers/clay) turns it
// into one provider's call and that provider's answer into these shapes.
//
// What a provider returns is what the provider said, never a verified fact: every person and
// channel is stored UNVERIFIED with the call that returned it (migration 016), and nothing here
// can make a person a decision maker, give them a relationship or a lawful basis, or say that a
// mailbox accepts mail.
import type { CallCredential, ProviderCost } from './gateway.js';

export const FACT_KINDS = ['title', 'email', 'phone', 'whatsapp', 'linkedin', 'instagram', 'x', 'contact_page'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type StatedConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** One thing a source said about a person or the business, before Scopely normalizes it. */
export interface ProviderFact {
  kind: FactKind;
  value: string;
  /** A public page the provider names for this value, when it names one. */
  sourceUrl?: string | null;
  /** The provider's own confidence, when it states one. Never computed. */
  confidence?: StatedConfidence | null;
}

/** A person a provider returned for a business. */
export interface ProviderPerson {
  /** The provider's own id for the person: how a repeat is recognised. */
  ref: string;
  fullName: string | null;
  /** The title as the provider reports it. A title is not a relationship or a decision. */
  title: string | null;
  confidence?: StatedConfidence | null;
  facts: ProviderFact[];
  /** The provider's record as the adapter read it, in the provider's own field names. */
  record: Record<string, unknown>;
}

/** Who to look up: the business as Scopely knows it, and what this provider said about it before. */
export interface ProspectQuery {
  businessName: string;
  domain: string | null;
  countryCode: string | null;
  /** Records this same provider returned for the business earlier (sources.provider_record). */
  providerRecords: Record<string, unknown>[];
}

export interface PeopleResult {
  people: ProviderPerson[];
  /** Channels of the business itself (no person). */
  businessFacts: ProviderFact[];
  /** When the provider answered, from its own clock when it gives one. */
  observedAt: string;
  ref: string | null;
  cost?: ProviderCost | null;
}

/** The ProspectIntelligenceProvider capability. One adapter per provider implements it. */
export interface ProspectIntelligenceProvider {
  readonly provider: string;
  readonly transport: 'live' | 'recorded';
  readonly label: string;
  /** The fact kinds this provider can return, so the screen never promises more. */
  readonly kinds: readonly FactKind[];
  /** The provider request, or why this business cannot be looked up here (never a guess by name alone). */
  plan(query: ProspectQuery): { request: Record<string, unknown> } | { refused: string };
  findPeople(request: Record<string, unknown>, credential: CallCredential | null): Promise<PeopleResult>;
}

export class ProspectProviderRegistry {
  private readonly providers = new Map<string, ProspectIntelligenceProvider>();
  register(p: ProspectIntelligenceProvider): this {
    if (this.providers.has(p.provider)) throw new Error(`a prospect provider for ${p.provider} is already registered`);
    this.providers.set(p.provider, p);
    return this;
  }
  get(provider: string): ProspectIntelligenceProvider | null { return this.providers.get(provider) ?? null; }
  list(): ProspectIntelligenceProvider[] { return [...this.providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)); }
}

/** Ceiling on people one lookup may store. A lookup is for a buyer, not a list of everyone. */
export const PROSPECT_PEOPLE_CEILING = 10;
