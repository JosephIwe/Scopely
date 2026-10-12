// Why this person, for this opportunity (Slice 12). A reading of what is on file, never a new fact:
// it is computed on every read, never stored, and every reason says where it comes from:
//
//   OBSERVED  seen on a public page or a register by a person, who recorded the basis
//   RECORDED  typed by a person in this workspace (a role, an address they have)
//   REPORTED  what a provider said, with the call that said it
//   INFERRED  Scopely's own reading of the above (a title that usually decides on this work)
//
// Only a recorded decision-maker basis makes someone a confirmed decision maker. A title, however
// senior, only ever makes them a likely buyer, and the screen says it is inferred.

export type ReasonState = 'OBSERVED' | 'RECORDED' | 'REPORTED' | 'INFERRED';
export type BuyerTier = 'DECISION_MAKER' | 'LIKELY_BUYER' | 'NAMED_CONTACT' | 'SHARED_ADDRESS';

export interface BuyerReason { state: ReasonState; text: string }
export interface BuyerAssessment { tier: BuyerTier; reasons: BuyerReason[]; summary: string }

export interface BuyerInput {
  name: string | null;
  role: string | null;
  relationship: string | null;
  relationshipBasis: string | null;
  isDecisionMaker: boolean;
  decisionMakerBasis: string | null;
  email: string | null;
  emailKind: string | null;
  /** The provider's label when the person came from a provider, else null. */
  provider: string | null;
  observedAt: string | null;
  /** Titles reported for the person by providers, with who reported them. */
  reportedTitles: { value: string; source: string }[];
}

export interface OpportunityInput { path: 'WEBSITE' | 'FIX' | null; serviceName: string | null; businessName: string }

/** Titles that usually decide on a small business's website work. A reading, never a decision. */
const BUYING_TITLE = /\b(owner|co-?founder|founder|proprietor|director|managing|principal|partner|ceo|chief executive|president|head of|practice manager|clinic manager|general manager|operations manager|marketing)\b/i;
const RELATIONSHIP_WORD: Record<string, string> = { owner: 'Owner', director: 'Director', partner: 'Partner', employee: 'Employee', other: 'Connected' };

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function assessBuyer(p: BuyerInput, o: OpportunityInput): BuyerAssessment {
  const work = o.serviceName ? `“${o.serviceName}”` : o.path === 'FIX' ? 'the website fix' : o.path === 'WEBSITE' ? 'a new website' : 'this work';
  const reasons: BuyerReason[] = [];
  if (p.isDecisionMaker && p.decisionMakerBasis) reasons.push({ state: 'OBSERVED', text: `Decision maker: ${p.decisionMakerBasis}` });
  if (p.relationship && p.relationshipBasis) {
    reasons.push({ state: 'OBSERVED', text: `${RELATIONSHIP_WORD[p.relationship] ?? p.relationship} of ${o.businessName}: ${p.relationshipBasis}` });
  }
  for (const t of p.reportedTitles) reasons.push({ state: 'REPORTED', text: `${t.source} lists their title as “${t.value}”${p.observedAt ? ` (${day(p.observedAt)})` : ''}` });
  if (p.role && !p.provider && !p.reportedTitles.some((t) => t.value.toLowerCase() === p.role!.toLowerCase())) {
    reasons.push({ state: 'RECORDED', text: `Role recorded as “${p.role}”` });
  }
  const titles = [p.role, ...p.reportedTitles.map((t) => t.value)].filter((x): x is string => Boolean(x));
  const senior = titles.find((t) => BUYING_TITLE.test(t)) ?? (p.relationship && ['owner', 'director', 'partner'].includes(p.relationship) ? RELATIONSHIP_WORD[p.relationship]! : null);

  if (p.isDecisionMaker && p.decisionMakerBasis) {
    return { tier: 'DECISION_MAKER', reasons, summary: `Confirmed decision maker for ${o.businessName}, on the basis recorded.` };
  }
  if (!p.name) {
    reasons.push({ state: 'INFERRED', text: 'A shared address: someone reads it, but no named person is behind it.' });
    return { tier: 'SHARED_ADDRESS', reasons, summary: 'A shared address, not a named buyer.' };
  }
  if (senior) {
    reasons.push({ state: 'INFERRED', text: `“${senior}” is a title that usually decides on ${work}. Inferred from the title, not confirmed.` });
    return { tier: 'LIKELY_BUYER', reasons, summary: `Likely buyer for ${work}. Not confirmed as the decision maker.` };
  }
  reasons.push({ state: 'INFERRED', text: `Nothing on file says they decide on ${work}. Ask them who does.` });
  return { tier: 'NAMED_CONTACT', reasons, summary: 'A named contact. Not shown to decide on this work.' };
}

const TIER_ORDER: Record<BuyerTier, number> = { DECISION_MAKER: 0, LIKELY_BUYER: 1, NAMED_CONTACT: 2, SHARED_ADDRESS: 3 };

/**
 * Who to contact first: the strongest tier, then someone the seller may email now, then the oldest
 * record. Null when no one is on file. A suggestion, never a decision.
 */
export function suggestBuyer<T extends { contactId: string; assessment: BuyerAssessment; readyToEmail: boolean }>(people: T[]): T | null {
  return [...people].sort((a, b) => TIER_ORDER[a.assessment.tier] - TIER_ORDER[b.assessment.tier]
    || Number(b.readyToEmail) - Number(a.readyToEmail) || Number(a.contactId) - Number(b.contactId))[0] ?? null;
}
