// Reading and correcting a captured page, without parsing it into anything else. The capture is
// kept byte for byte; a correction replaces only the value of the href attributes that equal the
// observed broken destination, in <a> tags outside comments, scripts and styles. Every other byte
// of the page stays as it was captured.

export const decodeEntities = (s: string): string => s
  .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeChar(parseInt(h, 16)))
  .replace(/&#([0-9]{1,7});/g, (_, d) => safeChar(parseInt(d, 10)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const safeChar = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

export const escAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A comment, a script or style block, or an opening <a> tag. Only the last is ever touched.
const SCAN = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<a\b[^>]*>/gi;
const HREF = /(\shref\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

export interface LinkMatch {
  /** Offset of the attribute value (including its quotes) in the page. */
  start: number;
  end: number;
  /** The attribute value as written, including its quotes. */
  raw: string;
  quote: '"' | "'" | '';
  /** Offset just after the opening tag, where the link's text begins. */
  tagEnd: number;
}

/** Every <a> whose href, once entities are decoded and whitespace trimmed, is exactly `href`. */
export function findLinks(html: string, href: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN.exec(html))) {
    if (!/^<a\b/i.test(m[0])) continue;
    const a = HREF.exec(m[0]);
    if (!a) continue;
    const value = a[3] ?? a[4] ?? a[5] ?? '';
    if (decodeEntities(value).trim() !== href) continue;
    const start = m.index + a.index + a[1]!.length;
    const raw = a[2]!;
    out.push({ start, end: start + raw.length, raw, quote: a[3] !== undefined ? '"' : a[4] !== undefined ? "'" : '', tagEnd: m.index + m[0].length });
  }
  return out;
}

/**
 * The page with the observed destination replaced by the corrected one in each matching link. The
 * new value keeps the original quote style (double quotes for an unquoted one).
 */
export function replaceLinks(html: string, observedHref: string, correctedHref: string): { html: string; replaced: number } {
  const links = findLinks(html, observedHref);
  let out = '';
  let at = 0;
  for (const l of links) {
    const q = l.quote === "'" ? "'" : '"';
    const value = q === "'" ? escAttr(correctedHref).replace(/'/g, '&#39;') : escAttr(correctedHref);
    out += html.slice(at, l.start) + q + value + q;
    at = l.end;
  }
  return { html: out + html.slice(at), replaced: links.length };
}

const text = (s: string) => decodeEntities(s.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Shortens text to about n characters, cutting at a word boundary where there is one. */
const clip = (s: string, n: number, fromEnd = false) => {
  if (s.length <= n) return s;
  if (fromEnd) {
    const cut = s.slice(s.length - n + 1);
    const sp = cut.indexOf(' ');
    return `…${sp > 0 && sp < 40 ? cut.slice(sp + 1) : cut}`;
  }
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${sp > n - 40 ? cut.slice(0, sp) : cut}…`;
};

/** What a person sees around the first matching link: its text, and a little of the page on each side. */
export function linkContext(html: string, href: string): { label: string | null; before: string; after: string } | null {
  const l = findLinks(html, href)[0];
  if (!l) return null;
  const close = html.slice(l.tagEnd).search(/<\/a\s*>/i);
  const inner = close >= 0 ? html.slice(l.tagEnd, l.tagEnd + close) : '';
  const label = text(inner) || null;
  const head = html.slice(0, l.start).lastIndexOf('<');
  const tail = close >= 0 ? l.tagEnd + close : l.tagEnd;
  return {
    label: label ? clip(label, 80) : null,
    before: clip(text(html.slice(Math.max(0, head - 4000), head)), 160, true),
    after: clip(text(html.slice(tail, tail + 4000).replace(/^<\/a\s*>/i, '')), 160),
  };
}

/** Decodes a captured page for reading. Pages are almost always UTF-8; anything else is read as Latin-1. */
export function pageText(bytes: Buffer, contentType: string): string {
  const cs = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().toLowerCase();
  return bytes.toString(cs && cs !== 'utf-8' && cs !== 'utf8' && /^(iso-8859-1|latin1|windows-1252)$/.test(cs) ? 'latin1' : 'utf8');
}
