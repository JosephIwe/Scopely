// The site document: a website project's whole state as structured data. It is what a version
// stores (its manifest), what edits change, and the only input the renderer reads. The browser
// never edits HTML; it sends edit operations against this document (operations.ts).
//
// A document also carries its basis, the BEFORE of the build: the opportunity, the evidence of
// the problem that was observed, what the build changes to address it, which facts it used, and
// what it deliberately did not use. The site itself never states any of that.
import type { BuildInstructions } from '../agents.js';
import type { BuildContext, BusinessFact } from '../context.js';
import { MERIDIAN, type SectionType, type SiteTemplate, sectionSpec } from './template.js';

export type CtaAction =
  | { kind: 'unset' }
  | { kind: 'phone'; value: string }
  | { kind: 'whatsapp'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'link'; value: string };

export interface Item { title: string; text: string }

export interface Section {
  type: SectionType;
  visible: boolean;
  variant?: string;
  /** Slot values: text slots are strings, image slots an asset id or null, images and items are lists. */
  content: Record<string, string | null | string[] | Item[]>;
}

/** Where a piece of content came from. `fact` and `business` values are never typed in. */
export type Provenance = 'template' | 'business' | 'fact' | 'person' | 'ai';

export interface ReviewsFact { rating: string | null; count: number | null; source: string; asOf: string | null }

export interface BuildBasis {
  opportunityId: string;
  opportunityType: string;
  service: string;
  /** The problem Scopely observed: the opportunity's evidence that still held when the build was made. */
  problem: { evidenceId: string; issueCode: string; plainIssue: string; url: string; quote: string; observedAt: string;
             confidence: 'HIGH' | 'MEDIUM' | 'LOW'; claimState: 'OBSERVED' | 'INFERRED' }[];
  /** What this build changes, and which evidence each change answers. */
  addresses: { evidenceIds: string[]; change: string }[];
  /** Facts the site states, each with its basis and source. */
  usedFacts: { attribute: string; basis: string; source: string }[];
  /** What the build did not use, and why. Never stated on the site. */
  notUsed: { what: string; why: string }[];
}

/** One field an AI edit changed, for the proposal card: what it was and what it became. */
export interface ChangeRow { section: SectionType | 'page'; label: string; from: string; to: string }

export interface SiteDocument {
  /** `scopely.site/1` for Meridian 1; `scopely.site/2` adds the style controls and the CTA band. */
  schema: 'scopely.site/1' | 'scopely.site/2';
  /** Named templateKey, not key: a bare "key" reads as a credential to the secret scan. */
  template: { templateKey: string; version: number };
  brand: { name: string };
  /** Schema 2 also carries button, spacing, image and backgrounds (template.styles keys). */
  theme: { palette: string; fonts: string; accent: string | null; button?: string; spacing?: string; image?: string; backgrounds?: string };
  cta: { label: string; action: CtaAction };
  sections: Section[];
  facts: { reviews: ReviewsFact | null };
  /** Keyed `<section>.<slot>`, plus `cta` and `theme`. */
  provenance: Record<string, Provenance>;
  basis: BuildBasis;
  lastEdit: {
    by: 'generator' | 'person' | 'ai'; request: string | null; applied: string[]; needsInput: string[];
    /** Schema 2, AI edits: every field the edit changed, before and after. */
    changes?: ChangeRow[];
  };
}

export const SCHEMA_FOR_VERSION: Record<number, SiteDocument['schema']> = { 1: 'scopely.site/1', 2: 'scopely.site/2' };

const BOOKING_ISSUES = new Set(['E-BOOK-TO-ENQUIRY', 'E-NO-NEXT-STEP', 'E-CTA-DEAD-END']);
const CONTACT_LINK_ISSUES = new Set(['E-TEL-BROKEN', 'E-WA-BROKEN', 'E-LINK-TARGET-MISMATCH', 'E-EMAIL-INVALID', 'E-PLACEHOLDER-LINK']);

/** How a website build answers each observed issue. Grouped so one change can answer several findings. */
export function planChanges(ctx: BuildContext): { evidenceIds: string[]; change: string }[] {
  const groups = new Map<string, string[]>();
  const add = (change: string, id: string) => groups.set(change, [...(groups.get(change) ?? []), id]);
  for (const e of ctx.evidence) {
    if (e.issueCode === 'E-NO-WEBSITE') add('A complete website, where none could be found', e.evidenceId);
    else if (BOOKING_ISSUES.has(e.issueCode)) add('One clear next step: the same button in the hero, the contact section and a fixed bar on mobile', e.evidenceId);
    else if (CONTACT_LINK_ISSUES.has(e.issueCode)) add('Contact buttons are checked before they are saved: a WhatsApp button opens WhatsApp, a call button dials, an email button emails', e.evidenceId);
    else if (e.issueCode === 'E-FORM-BROKEN') add('Direct contact buttons in place of a form that fails', e.evidenceId);
    else if (e.issueCode === 'E-MOBILE-ONLY') add('A layout that works on every screen size, with the next step always in reach', e.evidenceId);
    else add(`A rebuilt site that addresses: ${e.plainIssue}`, e.evidenceId);
  }
  return [...groups.entries()].map(([change, evidenceIds]) => ({ evidenceIds, change }));
}

const PRIVATE_FACTS: Record<string, string> = {
  employee_count: 'staff numbers', revenue: 'revenue', website_status: 'website status', coordinates: 'map position',
};

// What each check looks at, in words a person reads on the setup screen.
const CHECK_NAMES: Record<string, string> = {
  booking_cta_trace: 'Where the booking button leads',
  booking_platform_fingerprint: 'Which booking system the site uses',
  contact_links: 'Contact links',
  placeholder_links: 'Unfinished links',
  stale_signals: 'Signs the site is out of date',
  trades_hours_and_routes: 'Opening hours and service area',
  website_presence: 'Whether the website is up',
};
const plain = (code: string) => {
  const check = code.replace(/^check\./, '').split('.')[0]!;
  return CHECK_NAMES[check] ?? check.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};
const WITHHELD_WHY: Record<string, string> = { website_status: 'not confirmed, so the site does not say whether a current website exists' };

export function describeBasis(ctx: BuildContext, instructions: BuildInstructions | null): BuildBasis {
  const reviews = ctx.facts.find((f) => f.attribute === 'reviews');
  return {
    opportunityId: ctx.opportunity.opportunityId,
    opportunityType: ctx.opportunity.opportunityType,
    service: ctx.catalogItem.service,
    problem: ctx.evidence.map((e) => ({ evidenceId: e.evidenceId, issueCode: e.issueCode, plainIssue: e.plainIssue, url: e.url, quote: e.quote,
      observedAt: e.observedAt, confidence: e.confidence, claimState: e.claimState })),
    addresses: instructions ? instructions.tasks.map((t) => ({ evidenceIds: t.addressesEvidenceIds, change: t.title })) : planChanges(ctx),
    usedFacts: [
      { attribute: 'business name', basis: 'RECORDED', source: ctx.business.identitySources[0]?.sourceType ?? 'recorded business name' },
      ...(reviews ? [{ attribute: 'review rating and count', basis: reviews.basis, source: reviews.source }] : []),
    ],
    notUsed: [
      ...ctx.withheldFacts.map((w) => ({ what: w.attribute.replace(/_/g, ' '), why: WITHHELD_WHY[w.attribute] ?? w.reason })),
      ...ctx.facts.filter((f) => PRIVATE_FACTS[f.attribute]).map((f) => ({ what: PRIVATE_FACTS[f.attribute]!, why: 'known, but not something a public site should state' })),
      ...ctx.notObservable.map((o) => ({ what: plain(o.checkCode), why: 'could not be observed, so nothing is said about it' })),
      ...(ctx.notObservableNotes ? [{ what: 'operator note', why: ctx.notObservableNotes }] : []),
    ],
  };
}

function reviewsFact(f: BusinessFact | undefined): ReviewsFact | null {
  if (!f) return null;
  const count = f.value.count === null || f.value.count === undefined ? null : Number(f.value.count);
  // Stated as recorded: a numeric column's padding ("4.90") is not precision anyone measured.
  const rating = f.value.rating === null || f.value.rating === undefined ? null : String(f.value.rating).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (count === null && rating === null) return null;
  return { rating, count, source: f.source, asOf: f.asOf };
}

/**
 * The first version of a site, from the build context only. Deterministic: the same context and
 * template give the same document. Copy the template writes is neutral and claims nothing; every
 * slot it cannot fill from a sourced fact is left empty for a person to complete.
 */
export function generateDocument(ctx: BuildContext, instructions: BuildInstructions | null, t: SiteTemplate): SiteDocument {
  const name = ctx.business.name;
  const issues = new Set(ctx.evidence.map((e) => e.issueCode));
  const images = ctx.assets.filter((a) => a.kind === 'image').map((a) => a.assetId);
  const reviews = reviewsFact(ctx.facts.find((f) => f.attribute === 'reviews'));
  const ctaLabel = [...issues].some((i) => BOOKING_ISSUES.has(i)) ? 'Make an enquiry' : 'Get in touch';
  const content: Record<SectionType, Section['content']> = {
    hero: { eyebrow: '', headline: name, subheadline: 'Find out what we offer, and get in touch when you are ready.', image: images[0] ?? null },
    services: { heading: 'What we offer', intro: '', items: [] },
    about: { heading: `About ${name}`.slice(0, 60), body: '', image: images[1] ?? null },
    proof: { heading: 'What customers say' },
    gallery: { heading: 'Gallery', images: images.slice(0, 8) },
    cta: { heading: 'Take the next step', text: 'Get in touch whenever you are ready.' },
    contact: { heading: 'Get in touch', body: 'We would be glad to hear from you.', details: [] },
    footer: { note: '' },
  };
  const visible: Record<SectionType, boolean> = {
    hero: true, services: true, about: true, proof: reviews !== null, gallery: images.length >= 2, cta: true, contact: true, footer: true,
  };
  const provenance: Record<string, Provenance> = { 'hero.headline': 'business', 'about.heading': 'business', cta: 'template', theme: 'template' };
  for (const s of t.sections) {
    for (const slot of Object.keys(s.slots)) provenance[`${s.type}.${slot}`] ??= 'template';
  }
  if (reviews) provenance['proof.rating'] = 'fact';
  return {
    schema: SCHEMA_FOR_VERSION[t.version]!,
    template: { templateKey: t.key, version: t.version },
    brand: { name },
    theme: { palette: t.defaults.palette, fonts: t.defaults.fonts, accent: null, ...styleDefaults(t) },
    cta: { label: ctaLabel, action: { kind: 'unset' } },
    sections: t.sections.map((s) => ({ type: s.type, visible: visible[s.type], ...(s.variants ? { variant: s.variants[0]!.key } : {}),
      content: structuredClone(content[s.type]) })),
    facts: { reviews },
    provenance,
    basis: describeBasis(ctx, instructions),
    lastEdit: { by: 'generator', request: null, applied: [`Built from the ${t.name} template`], needsInput: [] },
  };
}

const styleDefaults = (t: SiteTemplate) => (t.styles
  ? { button: t.defaults.button!, spacing: t.defaults.spacing!, image: t.defaults.image!, backgrounds: t.defaults.backgrounds! } : {});

// Meridian 1 palettes, mapped to the nearest Meridian 2 palette.
const V1_PALETTE: Record<string, string> = { harbor: 'stone', evergreen: 'sage', clay: 'blush', graphite: 'noir', linen: 'stone' };

/**
 * A document in the current version of its template. A Meridian 1 document keeps everything a
 * person or the generator wrote (text, lists, images, the button, order, visibility, provenance
 * and the basis) and gains version 2's style controls and a call-to-action band before the
 * contact section. Colours and type map to the nearest version 2 choice; the banner hero becomes
 * centred. Stored versions are never rewritten: this runs only when a document becomes the base
 * of a new version, which is then made with the current template.
 */
export function upgradeDocument(doc: SiteDocument): SiteDocument {
  if (doc.template.version === MERIDIAN.version) return doc;
  if (doc.template.templateKey !== MERIDIAN.key || doc.template.version !== 1) throw new Error('no upgrade for this site document');
  const t = MERIDIAN;
  const d = structuredClone(doc);
  d.schema = SCHEMA_FOR_VERSION[t.version]!;
  d.template = { templateKey: t.key, version: t.version };
  d.theme = { palette: V1_PALETTE[d.theme.palette] ?? t.defaults.palette, fonts: d.theme.fonts, accent: d.theme.accent, ...styleDefaults(t) };
  for (const s of d.sections) if (s.type === 'hero' && !sectionSpec(t, 'hero').variants!.some((v) => v.key === s.variant)) s.variant = 'centered';
  if (!d.sections.some((s) => s.type === 'cta')) {
    const at = d.sections.findIndex((s) => s.type === 'contact');
    d.sections.splice(at, 0, { type: 'cta', visible: true, content: { heading: 'Take the next step', text: 'Get in touch whenever you are ready.' } });
    d.provenance['cta.heading'] = 'template';
    d.provenance['cta.text'] = 'template';
  }
  return d;
}

export interface ReadinessItem { section: SectionType | 'cta'; message: string }

/** What still needs a person before the site is ready to show. Advisory; approval is the person's call. */
export function readiness(doc: SiteDocument, t: SiteTemplate): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  if (doc.cta.action.kind === 'unset') out.push({ section: 'cta', message: 'The main button has no destination yet. Add a phone number, WhatsApp, email or link the business uses.' });
  for (const s of doc.sections) {
    if (!s.visible) continue;
    const spec = sectionSpec(t, s.type);
    if (s.type === 'services' && (s.content.items as Item[]).length === 0) out.push({ section: s.type, message: 'Add the services the business offers. They could not be observed, so none were written for you.' });
    if (s.type === 'about' && !String(s.content.body ?? '').trim()) out.push({ section: s.type, message: 'Add a few sentences about the business, or hide this section.' });
    if (s.type === 'gallery' && (s.content.images as string[]).length === 0) out.push({ section: s.type, message: 'Add photos, or hide the gallery.' });
    if (spec.factBound === 'reviews' && !doc.facts.reviews) out.push({ section: s.type, message: 'There is no sourced review data, so this section shows nothing. Hide it.' });
  }
  return out;
}
