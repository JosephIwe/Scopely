// Helpers both template renderers share. Changing what one of these returns changes stored
// artifacts' bytes, so treat them as frozen too.
import type { CtaAction } from './document.js';

export interface RenderImage { contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; bytes: Buffer; alt: string }

export interface RenderOptions {
  mode: 'artifact' | 'editor';
  /** Editor mode only: the section to outline. */
  selected?: string | null;
}

export const esc = (v: unknown): string => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const paragraphs = (v: string): string => v.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export function ctaHref(a: CtaAction): string | null {
  switch (a.kind) {
    case 'unset': return null;
    case 'phone': return `tel:${a.value}`;
    case 'whatsapp': return `https://wa.me/${a.value}`;
    case 'email': return `mailto:${a.value}`;
    case 'link': return a.value;
  }
}

export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** A plain label for a review source key (e.g. `google_places` → "Google places"). */
const SOURCE_NAMES: Record<string, string> = { google_places: 'Google', google: 'Google', trustpilot: 'Trustpilot', yelp: 'Yelp', facebook: 'Facebook' };
export const sourceLabel = (s: string) => {
  if (SOURCE_NAMES[s]) return SOURCE_NAMES[s];
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const monthYear = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
