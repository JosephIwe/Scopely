// The deterministic checks of an analysis. Each turns what a probe returned into observations in
// the Truth Rule's vocabulary:
//
//   OBSERVED       seen in the response or the served HTML;
//   INFERRED       derived from named OBSERVED facts of the same page (only "meaningful presence");
//   NOT_OBSERVABLE the check could not see it, so it says nothing either way.
//
// A finding becomes evidence only for an issue code a rule names, with the exact link quoted as
// served. Absence is never a finding: a widget, a form or a link can be added by script, which a
// fetch of the served HTML does not run. No model is involved; the same page always gives the same
// observations.
import { classifyWebsiteFetch, type FetchOutcome } from '../discovery/website.js';
import type { WebsiteStatus } from '../discovery/qualify.js';
import type { Probe, ProbeResult } from './fetch.js';
import { clean, type PageFacts, type PageLink, resolveHref } from './html.js';

export const ANALYZER = 'scopely.static/1';

export type ObservedState = 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE';

export interface CheckObservation {
  ruleKey: string;
  ruleVersion: number;
  checkCode: string;
  state: ObservedState;
  /** Absent exactly when NOT_OBSERVABLE. */
  result?: 'ok' | 'gap' | 'defect' | 'n/a';
  href?: string;
  visibleText?: string;
  /** What a person reads about this observation: one plain sentence. */
  fact: string;
  extracted?: Record<string, unknown>;
  /** INFERRED only: the check codes (on the same snapshot) it was derived from. */
  inferredFrom?: string[];
  evidence?: { issueCode: string; plainIssue: string; quote: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW' };
}

const R = {
  presence: ['check.website_presence', 1],
  signals: ['check.page_signals', 1],
  links: ['check.contact_links', 2],
  cta: ['check.booking_cta_trace', 2],
  platform: ['check.booking_platform_fingerprint', 2],
} as const;

const obs = (rule: keyof typeof R, o: Omit<CheckObservation, 'ruleKey' | 'ruleVersion'>): CheckObservation =>
  ({ ruleKey: R[rule][0], ruleVersion: R[rule][1], ...o });

const quoted = (label: string) => (label ? `"${clean(label, 60)}"` : 'unlabelled');

// ------------------------------------------------------------------ the page itself

/** The probe's outcome in classifyWebsiteFetch's terms. A refused redirect is a blocked fetch. */
export function fetchOutcome(p: ProbeResult): FetchOutcome {
  if (p.kind === 'response') return { kind: 'response', httpStatus: p.status };
  const e = p.error;
  return { kind: 'error', error: e === 'dns_not_found' || e === 'timeout' || e === 'tls' || e === 'connection_refused' || e === 'blocked' ? e : 'other' };
}

const ERROR_WORDS: Record<string, string> = {
  dns_not_found: 'its host name does not exist', timeout: 'it did not answer within 10 seconds', tls: 'its secure connection failed',
  connection_refused: 'it refused the connection', blocked: 'it led to an address that is not on the public web, which Scopely never requests',
  too_large: 'the page is larger than 2 MB', too_many_redirects: 'it redirected more than three times', other: 'the request failed',
};

/** Reachability, redirects and website status for the requested address. */
export function presenceObservation(p: ProbeResult): { observation: CheckObservation; status: Exclude<WebsiteStatus, 'WEBSITE_NOT_OBSERVED' | 'UNKNOWN'>; basis: 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVABLE' } {
  const c = classifyWebsiteFetch(fetchOutcome(p));
  const hops = p.hops.map((h) => ({ url: h.url, status: h.status }));
  if (p.kind === 'response') {
    const via = hops.length ? ` after ${hops.length} redirect${hops.length === 1 ? '' : 's'}` : '';
    const fact = p.status >= 200 && p.status < 300 ? `${p.finalUrl} answered ${p.status}${via}.`
      : `${p.finalUrl} answered ${p.status}${via}${c.basis === 'NOT_OBSERVABLE' ? ', which hides the site rather than showing it is missing' : ''}.`;
    const extracted = { status: p.status, finalUrl: p.finalUrl, redirects: hops, contentType: clean(p.contentType, 100) };
    return {
      status: c.status, basis: c.basis,
      observation: c.basis === 'NOT_OBSERVABLE'
        ? obs('presence', { checkCode: 'website_presence.fetch', state: 'NOT_OBSERVABLE', fact, extracted })
        : obs('presence', { checkCode: 'website_presence.fetch', state: 'OBSERVED', result: c.status === 'WEBSITE_PRESENT' ? 'ok' : 'gap', fact, extracted }),
    };
  }
  const fact = `${p.lastUrl} could not be read: ${ERROR_WORDS[p.error] ?? ERROR_WORDS.other}.`;
  const extracted = { error: p.error, lastUrl: p.lastUrl, redirects: hops };
  return {
    status: c.status, basis: c.basis,
    observation: c.basis === 'NOT_OBSERVABLE'
      ? obs('presence', { checkCode: 'website_presence.fetch', state: 'NOT_OBSERVABLE', fact, extracted })
      : obs('presence', { checkCode: 'website_presence.fetch', state: 'OBSERVED', result: 'gap', fact, extracted }),
  };
}

// Phrases that only a domain parking or "coming soon" page uses. A page that says one of them and
// little else is not a meaningful website; a page that merely mentions one is.
const PARKED = [
  /\bthis domain (name )?(is|may be) for sale\b/i, /\bbuy this domain\b/i, /\bdomain (is )?parked\b/i, /\bparked (free|domain)\b/i,
  /\bsedoparking\b/i, /\bparkingcrew\b/i, /\bhugedomains\b/i, /\bafternic\b/i, /\bwebsite (is )?coming soon\b/i, /\bsite (is )?under construction\b/i,
  /\bthis site can['’]?t be reached\b/i, /\bdefault web site page\b/i, /\bit works!\s*$/i, /\bwelcome to nginx\b/i,
];

/** Page facts from the served HTML. None of them is ever a finding. */
export function signalObservations(pageUrl: string, facts: PageFacts): CheckObservation[] {
  const out: CheckObservation[] = [];
  const https = new URL(pageUrl).protocol === 'https:';
  out.push(obs('signals', { checkCode: 'page_signals.https', state: 'OBSERVED', result: https ? 'ok' : 'gap',
    fact: https ? 'The page is served over HTTPS.' : 'The page is served over plain HTTP, not HTTPS.', extracted: { scheme: https ? 'https' : 'http' } }));
  out.push(obs('signals', { checkCode: 'page_signals.title', state: 'OBSERVED', result: facts.title ? 'ok' : 'gap',
    fact: facts.title ? `The page title is "${facts.title}".` : 'The served HTML has no page title.', extracted: { title: facts.title } }));
  out.push(obs('signals', { checkCode: 'page_signals.description', state: 'OBSERVED', result: facts.description ? 'ok' : 'gap',
    fact: facts.description ? 'The page has a meta description.' : 'The served HTML has no meta description.', extracted: { description: facts.description } }));
  const mobile = facts.viewport !== null && /width\s*=\s*device-width/i.test(facts.viewport);
  out.push(obs('signals', { checkCode: 'page_signals.viewport', state: 'OBSERVED', result: mobile ? 'ok' : 'gap',
    fact: mobile ? 'The page declares a mobile viewport (width=device-width).' : facts.viewport ? `The page's viewport is "${facts.viewport}", not device width.` : 'The served HTML declares no mobile viewport.',
    extracted: { viewport: facts.viewport } }));
  // Forms are counted, never submitted. None in the served HTML says nothing: script can add one.
  out.push(facts.forms.length
    ? obs('signals', { checkCode: 'page_signals.forms', state: 'OBSERVED', result: 'ok',
      fact: `The page has ${facts.forms.length === 1 ? 'a form' : `${facts.forms.length} forms`} in its HTML (not submitted).`,
      extracted: { forms: facts.forms.slice(0, 10).map((f) => ({ action: f.action ? clean(f.action, 200) : null, method: f.method, fields: f.fields })) } })
    : obs('signals', { checkCode: 'page_signals.forms', state: 'NOT_OBSERVABLE', fact: 'No form is in the served HTML; a form added by script cannot be ruled out.' }));
  const contact = facts.links.find((l) => /\bcontact\b/i.test(l.label) || /\/contact(-us)?\b/i.test(l.href));
  out.push(contact
    ? obs('signals', { checkCode: 'page_signals.contact_page', state: 'OBSERVED', result: 'ok', href: clean(contact.href, 500), visibleText: contact.label || undefined,
      fact: `The page links to a contact page (${quoted(contact.label)}).` })
    : obs('signals', { checkCode: 'page_signals.contact_page', state: 'NOT_OBSERVABLE', fact: 'No contact page link is in the served HTML; a menu built by script cannot be ruled out.' }));
  const parked = PARKED.find((p) => p.test(facts.text));
  const words = facts.text ? facts.text.split(' ').length : 0;
  out.push(obs('signals', { checkCode: 'page_signals.content', state: 'OBSERVED', result: parked && words < 300 ? 'gap' : 'ok',
    fact: parked && words < 300 ? 'The page reads as a parked, placeholder or default server page.' : `The page has about ${words} words of text in its HTML.`,
    extracted: { words, placeholder: Boolean(parked && words < 300) } }));
  const meaningful = !(parked && words < 300) && (facts.title !== null || words >= 50);
  out.push(obs('signals', { checkCode: 'page_signals.meaningful_presence', state: 'INFERRED', result: meaningful ? 'ok' : 'gap',
    inferredFrom: ['website_presence.fetch', 'page_signals.title', 'page_signals.content'],
    fact: meaningful ? 'From the answer, title and text: the business has a working website.' : 'From the answer, title and text: this address does not show a working website for the business.' }));
  return out;
}

// ------------------------------------------------------------------ contact links (check.contact_links v2)

type ContactKind = 'phone' | 'whatsapp' | 'email';

export function contactKind(href: string): ContactKind | null {
  if (/^tel:/i.test(href)) return 'phone';
  if (/^mailto:/i.test(href)) return 'email';
  if (/^(https?:\/\/)?(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\b/i.test(href) || /^whatsapp:/i.test(href)) return 'whatsapp';
  return null;
}

const decodeUri = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Why a tel: href cannot be dialled as written, or null. */
export function telDefect(href: string): string | null {
  const v = decodeUri(href.slice(4)).split(/[;?]/)[0]!.trim();
  if (!v) return 'has no number';
  if (/[a-z]/i.test(v)) return 'has letters in it, not just a number';
  const digits = v.replace(/\D/g, '');
  if (/^\+\s*44\s*\(?\s*0/.test(v)) return 'keeps the 0 after +44, so the number cannot be dialled';
  if (digits.length < 6) return 'has too few digits to be a phone number';
  return null;
}

/** The WhatsApp number a link opens, or why it cannot open a chat. Short links (wa.me/message/…) are not judged. */
export function whatsappDefect(href: string): { defect: string | null; judged: boolean } {
  let u: URL;
  try { u = new URL(/^whatsapp:/i.test(href) ? href.replace(/^whatsapp:\/*/i, 'https://api.whatsapp.com/') : /^https?:/i.test(href) ? href : `https://${href}`); } catch {
    return { defect: 'is not a link WhatsApp can open', judged: true };
  }
  const host = u.hostname.toLowerCase();
  if (host === 'chat.whatsapp.com' || /^\/(message|c|qr)\//i.test(u.pathname) || /^\/catalog\//i.test(u.pathname)) return { defect: null, judged: false };
  const raw = host === 'wa.me' ? decodeUri(u.pathname.replace(/^\/+|\/+$/g, '')) : (u.searchParams.get('phone') ?? '');
  if (host !== 'wa.me' && !u.searchParams.has('phone')) return { defect: null, judged: false };
  const n = raw.replace(/[\s().+-]/g, '');
  if (!n) return { defect: 'has no number', judged: true };
  if (/\D/.test(n)) return { defect: 'has characters that are not a number', judged: true };
  if (n.startsWith('0')) return { defect: `uses ${raw} without a country code, which WhatsApp cannot open`, judged: true };
  if (n.length < 8) return { defect: 'has too few digits to be a WhatsApp number', judged: true };
  return { defect: null, judged: true };
}

const PLACEHOLDER_MAIL = /^(example\.(com|org|net)|domain\.com|yourdomain\.[a-z]+|yoursite\.[a-z]+|yourcompany\.[a-z]+|email\.com|test\.com|company\.com|website\.com|mysite\.com)$/i;
const RESERVED_TLD = /\.(local|localhost|test|invalid|example|internal)$/i;

/** Why a mailto: href cannot reach a mailbox, or null. Whether the mailbox exists is never checked. */
export function mailDefect(href: string): string | null {
  const v = decodeUri(href.slice(7)).split('?')[0]!.split(',')[0]!.trim();
  if (!v) return 'has no address';
  if (!/^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(v)) return `goes to "${clean(v, 60)}", which is not an email address`;
  const domain = v.split('@')[1]!.toLowerCase();
  if (RESERVED_TLD.test(domain)) return `goes to ${clean(v, 80)}, a reserved domain that cannot receive mail`;
  if (PLACEHOLDER_MAIL.test(domain)) return `goes to ${clean(v, 80)}, a template placeholder address`;
  return null;
}

/** The observations of every contact link on the page (one per distinct link, at most 20 of each kind). */
export function contactObservations(pageUrl: string, facts: PageFacts): CheckObservation[] {
  const out: CheckObservation[] = [];
  const seen = new Set<string>();
  const perKind: Record<ContactKind, number> = { phone: 0, whatsapp: 0, email: 0 };
  for (const l of facts.links) {
    const kind = contactKind(l.href);
    if (!kind || seen.has(`${l.href}\u0000${l.label}`) || perKind[kind] >= 20) continue;
    seen.add(`${l.href}\u0000${l.label}`);
    perKind[kind]++;
    out.push(...contactLink(pageUrl, l, kind));
  }
  if (out.length === 0) {
    out.push(obs('links', { checkCode: 'contact_links.any', state: 'NOT_OBSERVABLE',
      fact: 'No phone, WhatsApp or email link is in the served HTML; links added by script cannot be ruled out.' }));
  } else if (perKind.email > 0) {
    out.push(obs('links', { checkCode: 'contact_links.mailbox', state: 'NOT_OBSERVABLE',
      fact: 'Whether the published email addresses accept mail is not checked.' }));
  }
  return out;
}

function contactLink(pageUrl: string, l: PageLink, kind: ContactKind): CheckObservation[] {
  const base = { href: clean(l.href, 500), visibleText: l.label || undefined, extracted: { kind } };
  const quote = l.raw;
  const out: CheckObservation[] = [];
  // A label that names WhatsApp but opens a call or an email (golden r1-the-mw-clinic-london, r2-fierce-face-skin-clinic).
  if (/whats\s*app/i.test(l.label) && kind !== 'whatsapp') {
    out.push(obs('links', { ...base, checkCode: 'contact_links.target', state: 'OBSERVED', result: 'defect',
      fact: `The link labelled ${quoted(l.label)} opens ${kind === 'phone' ? 'a phone call' : 'an email'}, not WhatsApp.`,
      evidence: { issueCode: 'E-LINK-TARGET-MISMATCH', confidence: 'HIGH', quote,
        plainIssue: `The link labelled ${quoted(l.label)} opens ${kind === 'phone' ? 'a phone call' : 'an email'}, not WhatsApp` } }));
  }
  if (kind === 'phone') {
    const d = telDefect(l.href);
    out.push(d
      ? obs('links', { ...base, checkCode: 'contact_links.phone', state: 'OBSERVED', result: 'defect', fact: `The ${quoted(l.label)} phone link ${d}.`,
        evidence: { issueCode: 'E-TEL-BROKEN', confidence: 'HIGH', quote, plainIssue: `The ${quoted(l.label)} phone link ${d}` } })
      : obs('links', { ...base, checkCode: 'contact_links.phone', state: 'OBSERVED', result: 'ok', fact: `The ${quoted(l.label)} phone link is a dialable number.` }));
  } else if (kind === 'whatsapp') {
    const w = whatsappDefect(l.href);
    out.push(!w.judged
      ? obs('links', { ...base, checkCode: 'contact_links.whatsapp', state: 'NOT_OBSERVABLE', fact: `The ${quoted(l.label)} WhatsApp link is a short or group link; where it leads is not checked.` })
      : w.defect
        ? obs('links', { ...base, checkCode: 'contact_links.whatsapp', state: 'OBSERVED', result: 'defect', fact: `The ${quoted(l.label)} WhatsApp link ${w.defect}.`,
          evidence: { issueCode: 'E-WA-BROKEN', confidence: 'HIGH', quote, plainIssue: `The ${quoted(l.label)} WhatsApp link ${w.defect}` } })
        : obs('links', { ...base, checkCode: 'contact_links.whatsapp', state: 'OBSERVED', result: 'ok', fact: `The ${quoted(l.label)} WhatsApp link has a number with a country code.` }));
  } else {
    const d = mailDefect(l.href);
    out.push(d
      ? obs('links', { ...base, checkCode: 'contact_links.email', state: 'OBSERVED', result: 'defect', fact: `The ${quoted(l.label)} email link ${d}.`,
        evidence: { issueCode: 'E-EMAIL-INVALID', confidence: 'HIGH', quote, plainIssue: `The ${quoted(l.label)} email link ${d}` } })
      : obs('links', { ...base, checkCode: 'contact_links.email', state: 'OBSERVED', result: 'ok', fact: `The ${quoted(l.label)} email link is an email address.` }));
  }
  void pageUrl;
  return out;
}

// ------------------------------------------------------------------ booking (fingerprint v2, CTA trace v2)

/** Self-booking platforms by host. From the v1 rule's list plus common platforms of the same kind. */
export const BOOKING_PLATFORMS: [RegExp, string][] = [
  [/(^|\.)pabau\.(com|me)$/, 'Pabau'], [/(^|\.)phorest\.(com|me)$/, 'Phorest'], [/(^|\.)zenoti\.com$/, 'Zenoti'], [/(^|\.)setmore\.com$/, 'Setmore'],
  [/(^|\.)semble\.io$/, 'Semble'], [/(^|\.)calendly\.com$/, 'Calendly'], [/(^|\.)acuityscheduling\.com$/, 'Acuity'], [/(^|\.)as\.me$/, 'Acuity'],
  [/(^|\.)collums\.co\.uk$/, 'Collums'], [/(^|\.)leadconnectorhq\.com$/, 'LeadConnector'], [/(^|\.)fresha\.com$/, 'Fresha'], [/(^|\.)treatwell\.[a-z.]+$/, 'Treatwell'],
  [/(^|\.)booksy\.com$/, 'Booksy'], [/(^|\.)simplybook\.(me|it)$/, 'SimplyBook'], [/(^|\.)cliniko\.com$/, 'Cliniko'], [/(^|\.)janeapp\.com$/, 'Jane'],
  [/(^|\.)timely\.(com|nz)$/, 'Timely'], [/(^|\.)gettimely\.com$/, 'Timely'], [/(^|\.)vagaro\.com$/, 'Vagaro'], [/(^|\.)mindbodyonline\.com$/, 'Mindbody'],
  [/(^|\.)nookal\.com$/, 'Nookal'], [/(^|\.)square\.site$/, 'Square'], [/(^|\.)squareup\.com$/, 'Square'], [/(^|\.)opentable\.[a-z.]+$/, 'OpenTable'],
  [/(^|\.)resdiary\.com$/, 'ResDiary'], [/(^|\.)dentally\.(co|com)$/, 'Dentally'], [/(^|\.)youcanbook\.me$/, 'YouCanBookMe'], [/(^|\.)tidycal\.com$/, 'TidyCal'],
];

export function bookingPlatform(url: URL | null): string | null {
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  return BOOKING_PLATFORMS.find(([re]) => re.test(host))?.[1] ?? null;
}

export function platformObservations(pageUrl: string, facts: PageFacts): CheckObservation[] {
  const found = new Map<string, string>();
  for (const addr of [...facts.links.map((l) => l.href), ...facts.resources]) {
    const name = bookingPlatform(resolveHref(addr, pageUrl, facts.base));
    if (name && !found.has(name)) found.set(name, clean(addr, 300));
  }
  if (found.size === 0) {
    return [obs('platform', { checkCode: 'booking_platform_fingerprint.platform', state: 'NOT_OBSERVABLE',
      fact: 'No self-booking platform is in the served HTML; a booking widget loaded by script cannot be ruled out.' })];
  }
  return [...found].map(([name, href]) => obs('platform', { checkCode: 'booking_platform_fingerprint.platform', state: 'OBSERVED', result: 'ok', href,
    fact: `The page uses ${name} for self-booking.`, extracted: { platform: name } }));
}

const BOOK_LABEL = /\b(book|booking|appointments?|reserve|schedule)\b/i;
export const MAX_DESTINATIONS = 3;

/** Booking calls to action, each traced once to where it leads. Nothing is submitted. */
export async function ctaObservations(probe: Probe, pageUrl: string, facts: PageFacts): Promise<{ observations: CheckObservation[]; requests: number }> {
  const out: CheckObservation[] = [];
  let requests = 0;
  const traced = new Set<string>();
  const page = new URL(pageUrl);
  for (const l of facts.links) {
    if (!BOOK_LABEL.test(l.label) || contactKind(l.href)) continue;
    const base = { href: clean(l.href, 500), visibleText: l.label || undefined };
    const target = resolveHref(l.href, pageUrl, facts.base);
    if (!target || !/^https?:$/.test(target.protocol) || /^#|^javascript:/i.test(l.href.trim())) {
      if (traced.has(`#${l.label}`)) continue;
      traced.add(`#${l.label}`);
      out.push(obs('cta', { ...base, checkCode: 'booking_cta_trace.target', state: 'NOT_OBSERVABLE',
        fact: `The ${quoted(l.label)} link is handled by script on the page, so where it leads is not observable.` }));
      continue;
    }
    const dest = new URL(target.toString());
    dest.hash = '';
    const key = dest.toString();
    if (traced.has(key)) continue;
    traced.add(key);
    const samePage = dest.origin === page.origin && dest.pathname === page.pathname && dest.search === page.search;
    if (samePage) {
      out.push(obs('cta', { ...base, checkCode: 'booking_cta_trace.target', state: 'NOT_OBSERVABLE',
        fact: `The ${quoted(l.label)} link points back to this page; whatever opens there is handled by script and not observable.` }));
      continue;
    }
    if (requests >= MAX_DESTINATIONS) continue;
    requests++;
    const r = await probe.get(key, { body: false });
    const extracted = r.kind === 'response'
      ? { destination: key, status: r.status, finalUrl: r.finalUrl, redirects: r.hops }
      : { destination: key, error: r.error, redirects: r.hops };
    const platform = bookingPlatform(r.kind === 'response' ? new URL(r.finalUrl) : dest);
    if (r.kind === 'response' && (r.status === 404 || r.status === 410)) {
      const what = `goes to ${clean(r.finalUrl, 200)}, which answered ${r.status} (${r.status === 404 ? 'not found' : 'gone'})`;
      out.push(obs('cta', { ...base, checkCode: 'booking_cta_trace.target', state: 'OBSERVED', result: 'defect', extracted, fact: `The ${quoted(l.label)} link ${what}.`,
        evidence: { issueCode: 'E-CTA-DEAD-END', confidence: 'MEDIUM', quote: l.raw, plainIssue: `The ${quoted(l.label)} booking link ${what}` } }));
    } else if (r.kind === 'error' && r.error === 'dns_not_found') {
      const what = `goes to ${clean(r.lastUrl, 200)}, whose host name does not exist`;
      out.push(obs('cta', { ...base, checkCode: 'booking_cta_trace.target', state: 'OBSERVED', result: 'defect', extracted, fact: `The ${quoted(l.label)} link ${what}.`,
        evidence: { issueCode: 'E-CTA-DEAD-END', confidence: 'MEDIUM', quote: l.raw, plainIssue: `The ${quoted(l.label)} booking link ${what}` } }));
    } else if (r.kind === 'response' && r.status >= 200 && r.status < 400) {
      out.push(obs('cta', { ...base, checkCode: 'booking_cta_trace.target', state: 'OBSERVED', result: 'ok', extracted: { ...extracted, platform },
        fact: `The ${quoted(l.label)} link opens ${clean(r.finalUrl, 200)}${platform ? ` (${platform})` : ''}, which answered ${r.status}.` }));
    } else {
      out.push(obs('cta', { ...base, checkCode: 'booking_cta_trace.target', state: 'NOT_OBSERVABLE', extracted,
        fact: `Where the ${quoted(l.label)} link leads could not be established: ${r.kind === 'response' ? `it answered ${r.status}` : ERROR_WORDS[r.error] ?? ERROR_WORDS.other}.` }));
    }
  }
  return { observations: out, requests };
}
