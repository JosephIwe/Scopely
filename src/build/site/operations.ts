// Edit operations: the only way a site document changes after it is generated. The visual editor
// and AI edits both produce these, and both go through `applyEdits`, which parses each operation
// strictly (known op, exact fields, types, lengths and formats), checks it against the template and
// the document as it stands, then applies it to a copy. Nothing else can write a document, and no
// operation carries HTML, CSS or a URL that is not a validated contact target.
import type { CtaAction, Item, Provenance, SiteDocument } from './document.js';
import { claimBlocker } from './claims.js';
import { type SectionType, type SiteTemplate, sectionSpec } from './template.js';

export type EditOperation =
  | { op: 'update_text'; section: SectionType; slot: string; value: string }
  | { op: 'update_items'; section: SectionType; slot: string; items: Item[] }
  | { op: 'replace_image'; section: SectionType; slot: string; assetId: string | null }
  | { op: 'set_images'; section: SectionType; slot: string; assetIds: string[] }
  | { op: 'update_cta'; label?: string; action?: CtaAction }
  | { op: 'change_color'; palette?: string; accent?: string | null }
  | { op: 'change_font'; fonts: string }
  | { op: 'change_layout'; section: SectionType; variant: string }
  | { op: 'show_section'; section: SectionType }
  | { op: 'hide_section'; section: SectionType }
  | { op: 'move_section'; section: SectionType; direction: 'up' | 'down' };

export type EditOrigin = 'person' | 'ai';

export interface EditEnv {
  template: SiteTemplate;
  /** Image assets of this project that may be placed. Anything else is refused. */
  imageAssetIds: ReadonlySet<string>;
  origin: EditOrigin;
  /** For an AI edit, the person's request. A contact target the person wrote there may be used. */
  requestText?: string;
}

export class EditRejected extends Error {
  constructor(readonly index: number, readonly reason: string) { super(`edit ${index + 1}: ${reason}`); }
}

const FIELDS: Record<EditOperation['op'], string[]> = {
  update_text: ['section', 'slot', 'value'],
  update_items: ['section', 'slot', 'items'],
  replace_image: ['section', 'slot', 'assetId'],
  set_images: ['section', 'slot', 'assetIds'],
  update_cta: ['label', 'action'],
  change_color: ['palette', 'accent'],
  change_font: ['fonts'],
  change_layout: ['section', 'variant'],
  show_section: ['section'],
  hide_section: ['section'],
  move_section: ['section', 'direction'],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Control, zero-width, line/paragraph-separator and bidirectional-override characters. */
const INVISIBLE = new RegExp(`[${[[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => `${String.fromCharCode(a!)}-${String.fromCharCode(b!)}`).join('')}]`, 'g');

/** Collapses whitespace (keeping line breaks where allowed) and drops control characters. */
function cleanText(v: unknown, multiline: boolean): string {
  if (typeof v !== 'string') throw new Error('must be text');
  let t = v.normalize('NFC').replace(INVISIBLE, '');
  t = multiline ? t.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ');
  return t.trim();
}

/** Validates a contact target and returns it normalised. */
export function parseCtaAction(v: unknown): CtaAction {
  if (!isObj(v) || typeof v.kind !== 'string') throw new Error('the button destination must name a kind');
  const keys = Object.keys(v).sort().join(',');
  if (v.kind === 'unset') {
    if (keys !== 'kind') throw new Error('unexpected field on the button destination');
    return { kind: 'unset' };
  }
  if (keys !== 'kind,value' || typeof v.value !== 'string') throw new Error('the button destination needs a value');
  const value = v.value.trim();
  switch (v.kind) {
    case 'phone': {
      const d = value.replace(/[\s().-]/g, '');
      if (!/^\+?[0-9]{6,15}$/.test(d)) throw new Error('that is not a phone number');
      return { kind: 'phone', value: d };
    }
    case 'whatsapp': {
      const d = value.replace(/[\s().+-]/g, '');
      if (!/^[1-9][0-9]{7,14}$/.test(d)) throw new Error('a WhatsApp number needs its country code, digits only (for example 447700900123)');
      return { kind: 'whatsapp', value: d };
    }
    case 'email': {
      if (value.length > 254 || !/^[^\s@<>"'`()[\]\\,;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/.test(value)) {
        throw new Error('that is not an email address');
      }
      return { kind: 'email', value };
    }
    case 'link': {
      let u: URL;
      try { u = new URL(value); } catch { throw new Error('that is not a web address'); }
      if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.') || value.length > 300) {
        throw new Error('a link must be a plain https:// address');
      }
      return { kind: 'link', value: u.toString() };
    }
    default:
      throw new Error('unknown button destination');
  }
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Parses one untrusted operation. Unknown ops and unknown or missing fields are refused. */
export function parseOperation(raw: unknown): EditOperation {
  if (!isObj(raw) || typeof raw.op !== 'string' || !(raw.op in FIELDS)) throw new Error('unknown edit');
  const op = raw.op as EditOperation['op'];
  const allowed = new Set(['op', ...FIELDS[op]]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected field ${JSON.stringify(k).slice(0, 40)}`);
  const str = (k: string) => { if (typeof raw[k] !== 'string') throw new Error(`${k} must be text`); return raw[k] as string; };
  switch (op) {
    case 'update_text': return { op, section: str('section') as SectionType, slot: str('slot'), value: str('value') };
    case 'update_items': {
      if (!Array.isArray(raw.items)) throw new Error('items must be a list');
      const items = raw.items.map((i) => {
        if (!isObj(i) || Object.keys(i).sort().join(',') !== 'text,title' || typeof i.title !== 'string' || typeof i.text !== 'string') {
          throw new Error('each item has a title and a text');
        }
        return { title: i.title, text: i.text };
      });
      return { op, section: str('section') as SectionType, slot: str('slot'), items };
    }
    case 'replace_image':
      if (raw.assetId !== null && typeof raw.assetId !== 'string') throw new Error('assetId must be an asset id or null');
      return { op, section: str('section') as SectionType, slot: str('slot'), assetId: raw.assetId as string | null };
    case 'set_images':
      if (!Array.isArray(raw.assetIds) || raw.assetIds.some((a) => typeof a !== 'string')) throw new Error('assetIds must be a list of asset ids');
      return { op, section: str('section') as SectionType, slot: str('slot'), assetIds: raw.assetIds as string[] };
    case 'update_cta': {
      if (raw.label === undefined && raw.action === undefined) throw new Error('nothing to change on the button');
      const out: EditOperation = { op };
      if (raw.label !== undefined) out.label = str('label');
      if (raw.action !== undefined) out.action = parseCtaAction(raw.action);
      return out;
    }
    case 'change_color': {
      if (raw.palette === undefined && raw.accent === undefined) throw new Error('nothing to change on the colours');
      const out: EditOperation = { op };
      if (raw.palette !== undefined) out.palette = str('palette');
      if (raw.accent !== undefined) {
        if (raw.accent !== null && (typeof raw.accent !== 'string' || !COLOR.test(raw.accent))) throw new Error('a colour is #rrggbb');
        out.accent = raw.accent === null ? null : (raw.accent as string).toLowerCase();
      }
      return out;
    }
    case 'change_font': return { op, fonts: str('fonts') };
    case 'change_layout': return { op, section: str('section') as SectionType, variant: str('variant') };
    case 'show_section': case 'hide_section': return { op, section: str('section') as SectionType };
    case 'move_section': {
      const d = str('direction');
      if (d !== 'up' && d !== 'down') throw new Error('direction is up or down');
      return { op, section: str('section') as SectionType, direction: d };
    }
  }
}

/** A short, plain description of an operation, for the version summary. */
export function describeOperation(op: EditOperation, t: SiteTemplate): string {
  const name = (s: string) => t.sections.find((x) => x.type === s)?.name ?? s;
  switch (op.op) {
    case 'update_text': return `Edited ${name(op.section)} ${sectionSpec(t, op.section).slots[op.slot]?.label.toLowerCase() ?? op.slot}`;
    case 'update_items': return `Updated ${name(op.section)} list (${op.items.length})`;
    case 'replace_image': return op.assetId ? `Changed ${name(op.section)} image` : `Removed ${name(op.section)} image`;
    case 'set_images': return `Updated ${name(op.section)} photos (${op.assetIds.length})`;
    case 'update_cta': return op.action ? `Main button now ${op.action.kind === 'unset' ? 'has no destination' : `opens ${op.action.kind === 'link' ? 'a link' : op.action.kind}`}` : `Main button reads "${op.label}"`;
    case 'change_color': return op.palette ? `Colours: ${t.palettes.find((p) => p.key === op.palette)?.name ?? op.palette}` : 'Accent colour changed';
    case 'change_font': return `Type: ${t.fonts.find((f) => f.key === op.fonts)?.name ?? op.fonts}`;
    case 'change_layout': return `${name(op.section)} layout: ${op.variant}`;
    case 'show_section': return `Showed ${name(op.section)}`;
    case 'hide_section': return `Hid ${name(op.section)}`;
    case 'move_section': return `Moved ${name(op.section)} ${op.direction}`;
  }
}

function applyOne(doc: SiteDocument, op: EditOperation, env: EditEnv): void {
  const t = env.template;
  const prov: Provenance = env.origin;
  const section = (type: string) => {
    const spec = t.sections.find((s) => s.type === type);
    const s = doc.sections.find((x) => x.type === type);
    if (!spec || !s) throw new Error(`there is no ${String(type).slice(0, 30)} section`);
    return { spec, s };
  };
  const machineText = (text: string) => {
    if (env.origin !== 'ai') return;
    const why = claimBlocker(text, doc.brand.name);
    if (why) throw new Error(`an AI edit cannot write that: ${why}`);
  };
  switch (op.op) {
    case 'update_text': {
      const { spec, s } = section(op.section);
      const slot = spec.slots[op.slot];
      if (!slot || slot.kind !== 'text') throw new Error(`${spec.name} has no text slot ${op.slot.slice(0, 30)}`);
      const v = cleanText(op.value, slot.multiline === true);
      if (v.length > slot.maxLength) throw new Error(`${slot.label} is limited to ${slot.maxLength} characters`);
      if (op.section === 'hero' && op.slot === 'headline' && !v) throw new Error('the headline cannot be empty');
      machineText(v);
      s.content[op.slot] = v;
      doc.provenance[`${op.section}.${op.slot}`] = prov;
      return;
    }
    case 'update_items': {
      const { spec, s } = section(op.section);
      const slot = spec.slots[op.slot];
      if (!slot || slot.kind !== 'items') throw new Error(`${spec.name} has no list ${op.slot.slice(0, 30)}`);
      if (op.items.length > slot.max) throw new Error(`${slot.label} holds at most ${slot.max}`);
      const items = op.items.map((i) => {
        const title = cleanText(i.title, false);
        const text = cleanText(i.text, false);
        const [ft, fx] = slot.fields;
        if (!title) throw new Error('each entry needs a title');
        if (title.length > ft!.maxLength || text.length > fx!.maxLength) throw new Error(`an entry in ${slot.label} is too long`);
        machineText(`${title} ${text}`);
        return { title, text };
      });
      s.content[op.slot] = items;
      doc.provenance[`${op.section}.${op.slot}`] = prov;
      return;
    }
    case 'replace_image': {
      const { spec, s } = section(op.section);
      const slot = spec.slots[op.slot];
      if (!slot || slot.kind !== 'image') throw new Error(`${spec.name} has no image slot ${op.slot.slice(0, 30)}`);
      if (op.assetId !== null && !env.imageAssetIds.has(op.assetId)) throw new Error('that image is not one of this project\'s images');
      s.content[op.slot] = op.assetId;
      return;
    }
    case 'set_images': {
      const { spec, s } = section(op.section);
      const slot = spec.slots[op.slot];
      if (!slot || slot.kind !== 'images') throw new Error(`${spec.name} has no photo list ${op.slot.slice(0, 30)}`);
      if (op.assetIds.length > slot.max) throw new Error(`${slot.label} holds at most ${slot.max}`);
      if (new Set(op.assetIds).size !== op.assetIds.length) throw new Error('a photo appears twice');
      if (op.assetIds.some((a) => !env.imageAssetIds.has(a))) throw new Error('that image is not one of this project\'s images');
      s.content[op.slot] = [...op.assetIds];
      return;
    }
    case 'update_cta': {
      if (op.label !== undefined) {
        const v = cleanText(op.label, false);
        if (!v || v.length > 32) throw new Error('the button label is 1 to 32 characters');
        machineText(v);
        doc.cta.label = v;
      }
      if (op.action !== undefined) {
        // A contact target is a fact about the business. Only a person may supply one.
        if (env.origin === 'ai' && op.action.kind !== 'unset' && !sameAction(op.action, doc.cta.action)
            && !writtenBy(op.action.value, env.requestText ?? '')) {
          throw new Error('an AI edit cannot make up a phone number, WhatsApp number, email or link; a person must supply it');
        }
        doc.cta.action = op.action;
      }
      doc.provenance.cta = prov;
      return;
    }
    case 'change_color': {
      if (op.palette !== undefined) {
        if (!t.palettes.some((p) => p.key === op.palette)) throw new Error('unknown colour scheme');
        doc.theme.palette = op.palette;
        if (op.accent === undefined) doc.theme.accent = null;
      }
      if (op.accent !== undefined) doc.theme.accent = op.accent;
      doc.provenance.theme = prov;
      return;
    }
    case 'change_font': {
      if (!t.fonts.some((f) => f.key === op.fonts)) throw new Error('unknown type pairing');
      doc.theme.fonts = op.fonts;
      doc.provenance.theme = prov;
      return;
    }
    case 'change_layout': {
      const { spec, s } = section(op.section);
      if (!spec.variants?.some((v) => v.key === op.variant)) throw new Error(`${spec.name} has no ${op.variant.slice(0, 30)} layout`);
      s.variant = op.variant;
      return;
    }
    case 'show_section': case 'hide_section': {
      const { spec, s } = section(op.section);
      if (!spec.hideable) throw new Error(`${spec.name} is always shown`);
      if (op.op === 'show_section' && spec.factBound === 'reviews' && !doc.facts.reviews) {
        throw new Error('there is no sourced review data to show');
      }
      s.visible = op.op === 'show_section';
      return;
    }
    case 'move_section': {
      const { spec } = section(op.section);
      if (!spec.movable) throw new Error(`${spec.name} cannot move`);
      const i = doc.sections.findIndex((x) => x.type === op.section);
      const j = op.direction === 'up' ? i - 1 : i + 1;
      const other = doc.sections[j];
      if (!other || !sectionSpec(t, other.type).movable) throw new Error(`${spec.name} cannot move further ${op.direction}`);
      [doc.sections[i], doc.sections[j]] = [other, doc.sections[i]!];
      return;
    }
  }
}

/** True when the person's own request contains `value` (digits compared for numbers). */
function writtenBy(value: string, request: string): boolean {
  if (/^\+?[0-9]+$/.test(value)) {
    const digits = value.replace(/\D/g, '');
    return (request.match(/\+?[0-9][0-9\s().-]{5,}[0-9]/g) ?? []).some((m) => m.replace(/\D/g, '') === digits);
  }
  return request.toLowerCase().includes(value.toLowerCase().replace(/\/$/, ''));
}

const sameAction = (a: CtaAction, b: CtaAction) => a.kind === b.kind && ('value' in a ? a.value : null) === ('value' in b ? b.value : null);

/**
 * Parses, validates and applies untrusted operations in order to a copy of `doc`. Throws
 * EditRejected naming the first operation that cannot be applied; nothing is applied then.
 */
export function applyEdits(doc: SiteDocument, rawOps: unknown, env: EditEnv): { document: SiteDocument; applied: EditOperation[] } {
  if (!Array.isArray(rawOps)) throw new EditRejected(0, 'edits must be a list');
  if (rawOps.length > 200) throw new EditRejected(200, 'too many edits at once; save and continue');
  const out = structuredClone(doc);
  const applied: EditOperation[] = [];
  rawOps.forEach((raw, i) => {
    try {
      const op = parseOperation(raw);
      applyOne(out, op, env);
      applied.push(op);
    } catch (err) {
      if (err instanceof EditRejected) throw err;
      throw new EditRejected(i, (err as Error).message);
    }
  });
  return { document: out, applied };
}

/** Checks a whole document against its template. Used before any document is stored or rendered from storage. */
export function assertValidDocument(doc: unknown, t: SiteTemplate): asserts doc is SiteDocument {
  const d = doc as SiteDocument;
  if (!isObj(doc) || d.schema !== 'scopely.site/1' || d.template?.templateKey !== t.key || d.template?.version !== t.version) throw new Error('not a site document for this template');
  if (!Array.isArray(d.sections) || d.sections.length !== t.sections.length) throw new Error('site document sections do not match the template');
  const types = d.sections.map((s) => s.type);
  if (new Set(types).size !== types.length || types.some((x) => !t.sections.some((s) => s.type === x))) throw new Error('site document sections do not match the template');
  if (types[0] !== 'hero' || types[types.length - 1] !== 'footer') throw new Error('hero comes first and footer last');
  if (!t.palettes.some((p) => p.key === d.theme?.palette) || !t.fonts.some((f) => f.key === d.theme?.fonts)) throw new Error('unknown theme');
  if (d.theme.accent !== null && !COLOR.test(String(d.theme.accent))) throw new Error('unknown accent colour');
  parseCtaAction(d.cta?.action);
  for (const s of d.sections) {
    const spec = sectionSpec(t, s.type);
    if (s.variant !== undefined && !spec.variants?.some((v) => v.key === s.variant)) throw new Error('unknown layout');
    for (const k of Object.keys(s.content)) if (!(k in spec.slots)) throw new Error(`unknown slot ${k.slice(0, 30)}`);
  }
}
