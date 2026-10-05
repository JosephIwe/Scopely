// Reading a served page without running it. Nothing here executes script, follows a form or
// builds a DOM: it scans the HTML the server sent for the few things the checks need, skipping
// comments, scripts and styles the same way the Fix Builder does, so a link quoted here is found
// again byte for byte when the page is captured for a fix.
import { decodeEntities } from '../build/fix/page.js';

export interface PageLink {
  /** The href once entities are decoded and whitespace trimmed (how the Fix Builder compares it). */
  href: string;
  /** The link's visible text, collapsed and clipped. */
  label: string;
  /** The link exactly as served, from `<a` to `</a>` (or the opening tag alone when that is long). */
  raw: string;
  attrs: Record<string, string>;
}

export interface PageForm {
  action: string | null;
  method: string;
  fields: number;
}

export interface PageFacts {
  title: string | null;
  description: string | null;
  viewport: string | null;
  base: string | null;
  links: PageLink[];
  forms: PageForm[];
  /** Addresses of scripts, frames and stylesheet or preload links: where a widget would come from. */
  resources: string[];
  /** Visible text, collapsed, for recognising a parked or placeholder page. Never stored. */
  text: string;
}

const MAX_LINKS = 400;
const MAX_RAW = 400;

const SCAN = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<a\b[^>]*>|<form\b[^>]*>|<\/form\s*>|<(?:input|select|textarea)\b[^>]*>|<(?:iframe|link|meta|base)\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title\s*>/gi;
const ATTR = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Removes control characters and collapses whitespace: what is left is safe to keep as text. */
export const clean = (s: string, max: number): string => {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export function attributes(tag: string): Record<string, string> {
  const inner = tag.replace(/^<\/?[a-z0-9]+/i, '').replace(/\/?>$/, '');
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(inner))) {
    const k = m[1]!.toLowerCase();
    if (k in out) continue;
    out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const textOf = (html: string) => decodeEntities(html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' '));

export function readPage(html: string): PageFacts {
  const facts: PageFacts = { title: null, description: null, viewport: null, base: null, links: [], forms: [], resources: [], text: '' };
  let form: PageForm | null = null;
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN.exec(html))) {
    const tag = m[0];
    const name = /^<(\/?[a-z0-9!-]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (name.startsWith('!--') || name === 'style') continue;
    if (name === 'script') {
      const src = attributes(/^<script\b[^>]*>/i.exec(tag)![0]).src;
      if (src) facts.resources.push(src.trim());
      continue;
    }
    if (name === 'title') {
      if (facts.title === null) facts.title = clean(textOf(tag), 200) || null;
      continue;
    }
    if (name === 'a') {
      if (facts.links.length >= MAX_LINKS) continue;
      const attrs = attributes(tag);
      if (attrs.href === undefined) continue;
      const start = m.index;
      const tagEnd = start + tag.length;
      const close = html.slice(tagEnd, tagEnd + 20_000).search(/<\/a\s*>/i);
      const inner = close >= 0 ? html.slice(tagEnd, tagEnd + close) : '';
      const whole = close >= 0 ? html.slice(start, tagEnd + close + html.slice(tagEnd + close).indexOf('>') + 1) : tag;
      const label = clean(textOf(inner), 120) || clean(attrs['aria-label'] ?? attrs.title ?? '', 120);
      facts.links.push({ href: attrs.href.trim(), label, raw: whole.length <= MAX_RAW ? whole : tag.slice(0, MAX_RAW), attrs });
      continue;
    }
    if (name === 'form') {
      const a = attributes(tag);
      form = { action: a.action?.trim() || null, method: (a.method ?? 'get').toLowerCase(), fields: 0 };
      facts.forms.push(form);
      continue;
    }
    if (name === '/form') { form = null; continue; }
    if (name === 'input' || name === 'select' || name === 'textarea') {
      if (form && (attributes(tag).type ?? '').toLowerCase() !== 'hidden') form.fields++;
      continue;
    }
    const a = attributes(tag);
    if (name === 'iframe' && a.src) facts.resources.push(a.src.trim());
    else if (name === 'link' && a.href && /\b(stylesheet|preload|prefetch|preconnect|dns-prefetch)\b/i.test(a.rel ?? '')) facts.resources.push(a.href.trim());
    else if (name === 'base' && a.href && facts.base === null) facts.base = a.href.trim();
    else if (name === 'meta') {
      const key = (a.name ?? a.property ?? '').toLowerCase();
      if (key === 'description' && facts.description === null) facts.description = clean(a.content ?? '', 300) || null;
      if (key === 'viewport' && facts.viewport === null) facts.viewport = clean(a.content ?? '', 200) || null;
    }
  }
  facts.text = clean(textOf(html), 4000);
  return facts;
}

/** An href resolved against the page (and its <base>, when that is a web address), or null. */
export function resolveHref(href: string, pageUrl: string, base: string | null): URL | null {
  try {
    const b = base && /^https?:/i.test(base) ? new URL(base, pageUrl).toString() : pageUrl;
    return new URL(href, b);
  } catch { return null; }
}
