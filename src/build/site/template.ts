// The first website template. A template is a structured design definition, not code: which
// sections exist and in what order they may appear, what content slots each section has and how
// long each may be, which controls a person may use on it, the design tokens it offers, and its
// responsive rules (which live in the renderer's stylesheet, keyed by these same names).
//
// One template only, deliberately. It is written for any local service business and names no
// business, seller, place or niche.

export type SectionType = 'hero' | 'services' | 'about' | 'proof' | 'gallery' | 'contact' | 'footer';

export type SlotSpec =
  | { kind: 'text'; label: string; maxLength: number; multiline?: boolean; placeholder: string }
  | { kind: 'image'; label: string }
  | { kind: 'images'; label: string; max: number }
  | { kind: 'items'; label: string; max: number; fields: { key: 'title' | 'text'; label: string; maxLength: number }[] };

export interface SectionSpec {
  type: SectionType;
  name: string;
  /** What the section is for, shown beside its controls. */
  purpose: string;
  slots: Record<string, SlotSpec>;
  /** Hero and footer stay first and last; the rest may be reordered among themselves. */
  movable: boolean;
  hideable: boolean;
  variants?: { key: string; name: string }[];
  /** A section whose content comes only from a sourced fact and cannot be typed in. */
  factBound?: 'reviews';
}

export interface Palette {
  key: string; name: string;
  bg: string; surface: string; ink: string; muted: string; line: string;
  accent: string; accentInk: string; band: string; bandInk: string;
}

export interface FontPair { key: string; name: string; heading: string; body: string; headingWeight: number; tracking: string }

export interface SiteTemplate {
  key: string;
  version: number;
  name: string;
  description: string;
  /** Which build kind the template builds. */
  buildKind: 'website';
  sections: SectionSpec[];
  palettes: Palette[];
  fonts: FontPair[];
  defaults: { palette: string; fonts: string };
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif';

export const MERIDIAN: SiteTemplate = {
  key: 'meridian',
  version: 1,
  name: 'Meridian',
  description: 'A calm, confident site for a local service business: one clear next step on every screen, room for real photos, and nothing it cannot back up.',
  buildKind: 'website',
  sections: [
    { type: 'hero', name: 'Hero', purpose: 'Who this is and the one thing to do next.', movable: false, hideable: false,
      variants: [{ key: 'split', name: 'Split' }, { key: 'centered', name: 'Centred' }, { key: 'banner', name: 'Banner' }],
      slots: {
        eyebrow: { kind: 'text', label: 'Small line above the headline', maxLength: 60, placeholder: 'A short line about what you do' },
        headline: { kind: 'text', label: 'Headline', maxLength: 90, placeholder: 'Business name' },
        subheadline: { kind: 'text', label: 'Supporting line', maxLength: 220, multiline: true, placeholder: 'One or two sentences' },
        image: { kind: 'image', label: 'Hero image' },
      } },
    { type: 'services', name: 'Services', purpose: 'What the business offers, in its own words.', movable: true, hideable: true,
      slots: {
        heading: { kind: 'text', label: 'Heading', maxLength: 60, placeholder: 'What we offer' },
        intro: { kind: 'text', label: 'Introduction', maxLength: 240, multiline: true, placeholder: 'Optional introduction' },
        items: { kind: 'items', label: 'Services', max: 6, fields: [
          { key: 'title', label: 'Service', maxLength: 50 }, { key: 'text', label: 'Description', maxLength: 180 }] },
      } },
    { type: 'about', name: 'About', purpose: 'Who is behind the business.', movable: true, hideable: true,
      slots: {
        heading: { kind: 'text', label: 'Heading', maxLength: 60, placeholder: 'About us' },
        body: { kind: 'text', label: 'Text', maxLength: 900, multiline: true, placeholder: 'A few sentences about the business' },
        image: { kind: 'image', label: 'Image' },
      } },
    { type: 'proof', name: 'Reviews', purpose: 'Review rating and count, only from a named review source.', movable: true, hideable: true,
      factBound: 'reviews',
      slots: { heading: { kind: 'text', label: 'Heading', maxLength: 60, placeholder: 'What customers say' } } },
    { type: 'gallery', name: 'Gallery', purpose: 'Real photos supplied by the seller or the business.', movable: true, hideable: true,
      slots: {
        heading: { kind: 'text', label: 'Heading', maxLength: 60, placeholder: 'Gallery' },
        images: { kind: 'images', label: 'Photos', max: 8 },
      } },
    { type: 'contact', name: 'Contact', purpose: 'How to reach the business, repeated where people decide.', movable: true, hideable: false,
      slots: {
        heading: { kind: 'text', label: 'Heading', maxLength: 60, placeholder: 'Get in touch' },
        body: { kind: 'text', label: 'Text', maxLength: 300, multiline: true, placeholder: 'A short invitation' },
        details: { kind: 'items', label: 'Details (hours, area served…)', max: 4, fields: [
          { key: 'title', label: 'Label', maxLength: 30 }, { key: 'text', label: 'Detail', maxLength: 120 }] },
      } },
    { type: 'footer', name: 'Footer', purpose: 'Closing line.', movable: false, hideable: false,
      slots: { note: { kind: 'text', label: 'Footer note', maxLength: 160, placeholder: 'Optional closing line' } } },
  ],
  palettes: [
    { key: 'harbor', name: 'Harbour', bg: '#F5F2EC', surface: '#FFFFFF', ink: '#15212B', muted: '#5A6570', line: '#E2DCD2',
      accent: '#1E5162', accentInk: '#FFFFFF', band: '#15212B', bandInk: '#F5F2EC' },
    { key: 'evergreen', name: 'Evergreen', bg: '#F2F4EF', surface: '#FFFFFF', ink: '#18241C', muted: '#56635A', line: '#DDE3D8',
      accent: '#2E5E3E', accentInk: '#FFFFFF', band: '#18241C', bandInk: '#F2F4EF' },
    { key: 'clay', name: 'Clay', bg: '#FBF4EC', surface: '#FFFFFF', ink: '#2B1E17', muted: '#6E5B50', line: '#EEDFD1',
      accent: '#B2522B', accentInk: '#FFFFFF', band: '#2B1E17', bandInk: '#FBF4EC' },
    { key: 'graphite', name: 'Graphite & gold', bg: '#111315', surface: '#1A1D21', ink: '#F1ECE3', muted: '#A9A398', line: '#2B2F34',
      accent: '#C9AA6B', accentInk: '#111315', band: '#0A0B0C', bandInk: '#F1ECE3' },
    { key: 'linen', name: 'Linen', bg: '#FAF8F4', surface: '#FFFFFF', ink: '#1C1C1C', muted: '#616161', line: '#E8E4DC',
      accent: '#1C1C1C', accentInk: '#FAF8F4', band: '#1C1C1C', bandInk: '#FAF8F4' },
  ],
  fonts: [
    { key: 'modern', name: 'Modern', heading: SANS, body: SANS, headingWeight: 700, tracking: '-0.02em' },
    { key: 'editorial', name: 'Editorial', heading: SERIF, body: SANS, headingWeight: 500, tracking: '-0.01em' },
    { key: 'classic', name: 'Classic', heading: SERIF, body: SERIF, headingWeight: 600, tracking: '0' },
  ],
  defaults: { palette: 'harbor', fonts: 'modern' },
};

const TEMPLATES = new Map<string, SiteTemplate>([[MERIDIAN.key, MERIDIAN]]);

export function getTemplate(key: string, version?: number): SiteTemplate {
  const t = TEMPLATES.get(key);
  if (!t || (version !== undefined && version !== t.version)) throw new Error(`no website template ${key}${version ? `@${version}` : ''}`);
  return t;
}

export function listTemplates(buildKind: string): SiteTemplate[] {
  return [...TEMPLATES.values()].filter((t) => t.buildKind === buildKind);
}

export function sectionSpec(t: SiteTemplate, type: string): SectionSpec {
  const s = t.sections.find((x) => x.type === type);
  if (!s) throw new Error(`template ${t.key} has no ${type} section`);
  return s;
}
