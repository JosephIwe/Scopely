// What machine-written site copy may not say. Text a template or an AI edit writes must claim
// nothing about the business: no numbers, prices, ratings, contact details, credentials, history,
// availability or superlatives, and nothing about what the business lacks (a finding is never
// turned into public copy, and something that could not be observed is never stated as absent).
//
// A person typing into the editor is the basis for what they type, so person text is only
// length- and format-checked. Sourced facts (the review rating) are rendered from the fact itself,
// with its source, and are never free text.

const CLAIM_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\d{2,}/, why: 'a number (a phone number, year, price or count) is a factual claim' },
  { re: /@|https?:|www\.|\.(com|co\.uk|net|org|io)\b/i, why: 'contact details and links come from the button settings, never from copy' },
  { re: /[£$€¥]|%|\bper ?cent\b/i, why: 'prices and percentages are claims' },
  { re: /\b(rated|ratings?|reviews?|stars?|testimonials?)\b/i, why: 'ratings and reviews come only from a sourced review fact' },
  { re: /\b(awards?|award-winning|certified|accredited|licen[cs]ed|insured|qualified|registered|approved|guarantee[ds]?|warrant(y|ies))\b/i, why: 'credentials and guarantees are claims' },
  { re: /\b(established|since|founded|years? of experience|decades?|generations?|family[- ]run|family[- ]owned|trusted by|thousands|hundreds)\b/i, why: 'history and track record are claims' },
  { re: /\b(best|leading|number one|#1|top[- ]rated|cheapest|fastest|unbeatable|premier|finest)\b/i, why: 'superlatives are claims' },
  { re: /\b(24\/7|24 hours|open (now|late|daily|every day)|same[- ]day|next[- ]day|emergency|free)\b/i, why: 'availability, speed and price are claims' },
  { re: /\b(no|without|lacks?|lacking|missing|broken|doesn'?t have|does not have)\b[^.]*\b(booking|website|site|phone|contact|form|online)\b/i,
    why: 'what a business lacks is a finding for the seller, not copy for its site' },
  { re: /\b(unlike before|you can now|now you can|finally|at last|no more|no longer|new and improved)\b/i,
    why: 'comparing with how things were restates a finding' },
  { re: /\b(book(ing)? online|online booking|book instantly|instant(ly)? book(ing)?|book (a|your) (slot|appointment|table) (online|now))\b/i,
    why: 'how bookings work is a fact about the business a person must confirm' },
];

/** The reason machine-written `text` would make a claim, or null. The business's own name is not a claim. */
export function claimBlocker(text: string, brandName: string): string | null {
  let t = text;
  if (brandName.trim()) t = t.split(brandName).join(' ');
  for (const p of CLAIM_PATTERNS) if (p.re.test(t)) return p.why;
  return null;
}
