// The website template. A template is a structured design definition, not code: which sections
// exist and in what order they may appear, what content slots each section has and how long each
// may be, which controls a person may use on it, the design tokens it offers, and its responsive
// rules (which live in the renderer's stylesheet, keyed by these same names).
//
// One template only, deliberately. It is written for any local service business and names no
// business, seller, place or niche.
//
// Versions: Meridian 1 is the Slice 5 look. Meridian 2 (Slice 6) restyles the same template in
// the design handoff's "Modern Clinic" direction: a call-to-action band, four palettes, three
// type pairings and four style controls. Version 1 stays registered, frozen, so every version
// built with it still renders to exactly its stored bytes; a new version is always made with the
// current template (upgradeDocument in document.ts).

export type SectionType = 'hero' | 'services' | 'about' | 'proof' | 'gallery' | 'cta' | 'contact' | 'footer';

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
  /** Version 2: the alternate section background and image placeholder tone. */
  tint?: string;
}

export interface FontPair {
  key: string; name: string; heading: string; body: string; headingWeight: number; tracking: string;
  /** Version 2: a line describing the pairing, the heading size scale, and the embedded faces (fonts.ts). */
  description?: string; scale?: number; faces?: string[];
}

export interface StyleOption { key: string; name: string }

/** Version 2's page-wide style controls. */
export interface SiteStyles { button: StyleOption[]; spacing: StyleOption[]; image: StyleOption[]; backgrounds: StyleOption[] }
export type StyleKey = keyof SiteStyles;

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
  styles?: SiteStyles;
  defaults: { palette: string; fonts: string } & Partial<Record<StyleKey, string>>;
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif';

/** Meridian 1 (Slice 5). Frozen: kept only so versions built with it render exactly as stored. */
export const MERIDIAN_V1: SiteTemplate = {
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

const GEIST = '"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/**
 * Meridian 2: the Slice 6 restyle in the design handoff's "Modern Clinic" direction. Same
 * template, same slots and rules as version 1, plus a call-to-action band and the style controls.
 */
export const MERIDIAN: SiteTemplate = {
  key: 'meridian',
  version: 2,
  name: 'Meridian',
  description: 'A calm, editorial site for a local service business: one clear next step on every screen, room for real photos, and nothing it cannot back up.',
  buildKind: 'website',
  sections: [
    { ...MERIDIAN_V1.sections.find((s) => s.type === 'hero')!, variants: [{ key: 'split', name: 'Split' }, { key: 'centered', name: 'Centred' }] },
    ...MERIDIAN_V1.sections.filter((s) => ['services', 'about', 'proof', 'gallery'].includes(s.type)),
    { type: 'cta', name: 'Call to action', purpose: 'A closing invitation with the main button, on the accent colour.', movable: true, hideable: true,
      slots: {
        heading: { kind: 'text', label: 'Headline', maxLength: 80, placeholder: 'Take the next step' },
        text: { kind: 'text', label: 'Supporting line', maxLength: 200, multiline: true, placeholder: 'Optional supporting line' },
      } },
    ...MERIDIAN_V1.sections.filter((s) => ['contact', 'footer'].includes(s.type)),
  ],
  palettes: [
    { key: 'stone', name: 'Stone', bg: '#F7F4EF', surface: '#FFFFFF', ink: '#23201C', muted: '#6B6359', line: '#E2DAD0', tint: '#EFE9E0',
      accent: '#6F533E', accentInk: '#FFFFFF', band: '#6F533E', bandInk: '#FFFFFF' },
    { key: 'sage', name: 'Sage', bg: '#F4F6F1', surface: '#FFFFFF', ink: '#1E2620', muted: '#5E6A60', line: '#D9E0D5', tint: '#E6ECE2',
      accent: '#3F5E48', accentInk: '#FFFFFF', band: '#3F5E48', bandInk: '#FFFFFF' },
    { key: 'blush', name: 'Blush', bg: '#FBF6F3', surface: '#FFFFFF', ink: '#2A1F1D', muted: '#76625E', line: '#ECDAD3', tint: '#F4E7E2',
      accent: '#9E5448', accentInk: '#FFFFFF', band: '#9E5448', bandInk: '#FFFFFF' },
    { key: 'noir', name: 'Noir', bg: '#151413', surface: '#1E1C1A', ink: '#F1ECE4', muted: '#A8A095', line: '#2F2C29', tint: '#1B1918',
      accent: '#D8C2A2', accentInk: '#151413', band: '#D8C2A2', bandInk: '#151413' },
  ],
  fonts: [
    { key: 'editorial', name: 'Editorial', description: 'Serif headlines, clean body text', heading: '"Instrument Serif", Georgia, serif', body: GEIST,
      headingWeight: 400, tracking: '-0.01em', scale: 1.14, faces: ['instrument', 'geist'] },
    { key: 'modern', name: 'Modern', description: 'Confident sans-serif throughout', heading: GEIST, body: GEIST,
      headingWeight: 600, tracking: '-0.035em', scale: 0.9, faces: ['geist'] },
    { key: 'classic', name: 'Classic', description: 'Traditional serif throughout', heading: '"Newsreader", Georgia, serif', body: '"Newsreader", Georgia, serif',
      headingWeight: 500, tracking: '-0.02em', scale: 0.98, faces: ['newsreader400', 'newsreader500'] },
  ],
  styles: {
    button: [{ key: 'rounded', name: 'Rounded' }, { key: 'pill', name: 'Pill' }, { key: 'square', name: 'Square' }],
    spacing: [{ key: 'compact', name: 'Compact' }, { key: 'comfortable', name: 'Comfortable' }, { key: 'airy', name: 'Airy' }],
    image: [{ key: 'soft', name: 'Soft' }, { key: 'square', name: 'Square' }, { key: 'arch', name: 'Arch' }],
    backgrounds: [{ key: 'plain', name: 'Plain' }, { key: 'alternate', name: 'Alternating' }],
  },
  defaults: { palette: 'stone', fonts: 'editorial', button: 'pill', spacing: 'comfortable', image: 'soft', backgrounds: 'alternate' },
};

/** Every registered version, newest last. Only the newest is offered for new work. */
const TEMPLATES = new Map<string, SiteTemplate[]>([[MERIDIAN.key, [MERIDIAN_V1, MERIDIAN]]]);

export function getTemplate(key: string, version?: number): SiteTemplate {
  const all = TEMPLATES.get(key);
  const t = version === undefined ? all?.[all.length - 1] : all?.find((x) => x.version === version);
  if (!t) throw new Error(`no website template ${key}${version ? `@${version}` : ''}`);
  return t;
}

/** The current version of a template. */
export const currentTemplate = (key: string): SiteTemplate => getTemplate(key);

export function listTemplates(buildKind: string): SiteTemplate[] {
  return [...TEMPLATES.values()].map((v) => v[v.length - 1]!).filter((t) => t.buildKind === buildKind);
}

export function sectionSpec(t: SiteTemplate, type: string): SectionSpec {
  const s = t.sections.find((x) => x.type === type);
  if (!s) throw new Error(`template ${t.key} has no ${type} section`);
  return s;
}
