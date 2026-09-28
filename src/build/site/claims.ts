// What machine-written site copy may not say. Text a template or an AI edit writes must claim
// nothing about the business: no numbers, prices, ratings, contact details, credentials, history,
// availability or superlatives, and nothing about what the business lacks (a finding is never
// turned into public copy, and something that could not be observed is never stated as absent).
//
// Since A16 an AI edit may write copy (headlines, supporting text, section text, service
// descriptions, button labels), but only through these same checks, so copy never becomes a claim.
// A sourced fact such as the review rating is rendered from the fact, never written as copy.
//
// A person typing into the editor is the basis for what they type, so person text is only
// length- and format-checked. Sourced facts (the review rating) are rendered from the fact itself,
// with its source, and are never free text.

const CLAIM_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /<[a-z/!?]|javascript:|data:|\{\{|\}\}|\$\{|\bon[a-z]+\s*=/i, why: 'copy is plain words; markup and code are refused' },
  { re: /\d{2,}/, why: 'a number (a phone number, year, price or count) is a factual claim' },
  { re: /@|https?:|www\.|\.(com|co\.uk|net|org|io)\b/i, why: 'contact details and links come from the button settings, never from copy' },
  { re: /[£$€¥]|%|\bper ?cent\b/i, why: 'prices and percentages are claims' },
  { re: /\b(rated|ratings?|reviews?|stars?|testimonials?)\b/i, why: 'ratings and reviews come only from a sourced review fact' },
  { re: /\b(awards?|award-winning|certified|accredited|licen[cs]ed|insured|qualified|registered|approved|guarantee[ds]?|warrant(y|ies))\b/i, why: 'credentials and guarantees are claims' },
  { re: /\b(chartered|board[- ]certified|fully trained|highly trained|experts?|specialists?|diplomas?|degrees?|fellows?)\b/i,
    why: 'qualifications and expertise are claims a person must supply' },
  { re: /\b(promise[ds]?|risk[- ]free|money[- ]back|satisfaction|member of|partner of|official partner|recogni[sz]ed by|as seen (in|on)|featured in)\b/i,
    why: 'guarantees, memberships and press mentions are claims' },
  { re: /\b\d+\s*(\+|x\b|times|clients?|customers?|patients?|projects?|jobs?|years?|staff|people|locations?|branches|clinics?)/i, why: 'a count or statistic is a factual claim' },
  { re: /\b(one|two|three|four|five|six|seven|eight|nine|ten|dozens|hundreds|thousands|millions)\s+(of\s+)?(happy\s+|satisfied\s+)?(clients|customers|patients|years|jobs|projects|people|families|locations|branches)\b/i,
    why: 'a count or statistic is a factual claim' },
  { re: /\b(based|located|situated|headquartered|operating) (in|out of|across|throughout)\b|\bin the heart of\b|\b(serving|covering) (the )?(whole |entire |greater |local )?\w+ (area|region|county|city|town|borough)\b/i,
    why: 'where a business is or works is a fact a person must supply' },
  { re: /\bwe (also )?(offer|provide|specialis\w*|specializ\w*|treat|fix|repair|install|cover|deliver|handle|stock|sell)\s+(?!you\b)[a-z]/i,
    why: 'which services a business offers comes from the services a person listed' },
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
