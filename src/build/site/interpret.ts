// AI editing, the interpreting half. An EditInterpreter turns a person's request ("make the hero
// feel more premium and change the button to WhatsApp") into edit operations. It proposes; it
// never applies. Whatever it returns is untrusted and goes through the same parser and validator
// as the visual editor (operations.ts) with origin 'ai', which also refuses machine-written claims
// and invented contact details.
//
// This slice ships one deterministic interpreter that uses no model. A model-backed interpreter
// later implements the same interface and receives a ModelProvider opened from the run's provider
// connection (agents.ts); the Build Workspace does not change when it arrives.
import type { ModelProvider } from '../agents.js';
import type { BuildContext } from '../context.js';
import type { SiteDocument } from './document.js';
import type { SiteTemplate } from './template.js';

export interface EditInterpretation {
  /** Untrusted operations, validated by applyEdits before anything changes. */
  operations: unknown[];
  /** What the interpreter could not do without a person, as questions. */
  needsInput: string[];
}

export interface EditInterpreter {
  key: string;
  version: string;
  /** Whether this interpreter needs a model from the run's provider connection. */
  modelUse: 'NONE' | 'PROVIDER_CONNECTION';
  interpret(input: { request: string; document: SiteDocument; template: SiteTemplate; context: BuildContext },
            model: ModelProvider | null): Promise<EditInterpretation>;
}

const SECTION_WORDS: [RegExp, string][] = [
  [/\bservices?\b|\bofferings?\b/, 'services'],
  [/\babout\b/, 'about'],
  [/\breviews?\b|\bratings?\b|\bproof\b|\btestimonials?\b/, 'proof'],
  [/\bgallery\b|\bphotos?\b|\bimages?\b|\bpictures?\b/, 'gallery'],
  [/\bcontact\b/, 'contact'],
];

const quoted = (s: string, after: RegExp): string | null => {
  const m = s.match(new RegExp(`${after.source}[^"“”']{0,40}["“']([^"“”']{1,120})["”']`, 'i'));
  return m ? m[1]!.trim() : null;
};

const numberIn = (s: string): string | null => {
  const m = s.match(/\+?[0-9][0-9\s().-]{6,}[0-9]/);
  return m ? m[0] : null;
};

/**
 * A deterministic interpreter: a fixed vocabulary of style, layout, section and button requests.
 * It never writes copy of its own beyond button labels, and never supplies a contact detail the
 * person did not write in the request.
 */
export class RuleBasedEditInterpreter implements EditInterpreter {
  readonly key = 'rules';
  readonly version = '1';
  readonly modelUse = 'NONE' as const;

  async interpret({ request, document }: { request: string; document: SiteDocument; template: SiteTemplate }): Promise<EditInterpretation> {
    const r = request.toLowerCase();
    const ops: unknown[] = [];
    const needsInput: string[] = [];
    const palette = (p: string) => ops.push({ op: 'change_color', palette: p });

    // Look and feel.
    if (/\b(premium|luxur(y|ious)|elegant|upscale|high[- ]end|sophisticated|refined|classy)\b/.test(r)) {
      palette('graphite');
      ops.push({ op: 'change_font', fonts: 'editorial' });
      if (/\bhero\b|\btop\b|\bheader\b/.test(r) || !/\b(section|services|about|gallery|contact)\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'centered' });
    } else if (/\b(minimal|clean|simple|airy|light(er)?)\b/.test(r)) { palette('linen'); ops.push({ op: 'change_font', fonts: 'modern' }); }
    else if (/\b(warm(er)?|friendly|welcoming|earthy|terracotta)\b/.test(r)) palette('clay');
    else if (/\b(green|natural|fresh|organic)\b/.test(r)) palette('evergreen');
    else if (/\b(blue|navy|calm|trustworthy|coastal)\b/.test(r)) palette('harbor');
    else if (/\b(dark(er)?|moody|night)\b/.test(r)) palette('graphite');
    if (!/\b(premium|luxur|elegant|upscale|high[- ]end|sophisticated|refined|classy)/.test(r)) {
      if (/\bserif\b|\bclassic(al)?\b|\btraditional\b/.test(r) && !/\bsans\b/.test(r)) ops.push({ op: 'change_font', fonts: /\bclassic|traditional/.test(r) ? 'classic' : 'editorial' });
      else if (/\bsans\b|\bmodern\b/.test(r)) ops.push({ op: 'change_font', fonts: 'modern' });
    }
    const hex = r.match(/#[0-9a-f]{6}\b/);
    if (hex && /\b(accent|colou?r|button)\b/.test(r)) ops.push({ op: 'change_color', accent: hex[0] });
    if (/\b(bold|dramatic|banner|full[- ]width|big(ger)? hero)\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'banner' });
    else if (/\bcent(er|re)d?\b/.test(r) && /\bhero\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'centered' });
    else if (/\bsplit\b|\bside by side\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'split' });

    // The main button.
    const aboutButton = /\b(cta|button|call to action)\b/.test(r);
    const label = quoted(request, /(?:cta|button|call to action)/);
    const num = numberIn(request);
    const current = document.cta.action;
    if (/\bwhats ?app\b/.test(r) && (aboutButton || /\bchange|switch|use|make\b/.test(r))) {
      if (num) ops.push({ op: 'update_cta', label: label ?? 'Message us on WhatsApp', action: { kind: 'whatsapp', value: num } });
      else if (current.kind === 'whatsapp') ops.push({ op: 'update_cta', label: label ?? 'Message us on WhatsApp' });
      else {
        ops.push({ op: 'update_cta', label: label ?? 'Message us on WhatsApp', action: { kind: 'unset' } });
        needsInput.push('Which WhatsApp number should the button open? Add it with the country code in the button settings.');
      }
    } else if (/\b(call|phone|ring)\b/.test(r) && aboutButton) {
      if (num) ops.push({ op: 'update_cta', label: label ?? 'Call us', action: { kind: 'phone', value: num } });
      else if (current.kind === 'phone') ops.push({ op: 'update_cta', label: label ?? 'Call us' });
      else { ops.push({ op: 'update_cta', label: label ?? 'Call us', action: { kind: 'unset' } }); needsInput.push('Which phone number should the button call?'); }
    } else if (/\bemail\b/.test(r) && aboutButton) {
      const email = request.match(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,24}/i)?.[0];
      if (email) ops.push({ op: 'update_cta', label: label ?? 'Email us', action: { kind: 'email', value: email } });
      else if (current.kind === 'email') ops.push({ op: 'update_cta', label: label ?? 'Email us' });
      else { ops.push({ op: 'update_cta', label: label ?? 'Email us', action: { kind: 'unset' } }); needsInput.push('Which email address should the button open?'); }
    } else if (label) {
      ops.push({ op: 'update_cta', label });
    }

    // Headline copy the person wrote.
    const headline = quoted(request, /\bheadline\b/);
    if (headline) ops.push({ op: 'update_text', section: 'hero', slot: 'headline', value: headline });
    const tagline = quoted(request, /\b(tagline|eyebrow)\b/);
    if (tagline) ops.push({ op: 'update_text', section: 'hero', slot: 'eyebrow', value: tagline });

    // Sections on and off, and order, one clause at a time ("hide the gallery and move services down").
    for (const clause of r.split(/\band\b|\bthen\b|[,;.]/)) {
      for (const [re, section] of SECTION_WORDS) {
        if (!re.test(clause)) continue;
        if (/\b(hide|remove|drop|turn off|get rid of)\b/.test(clause)) ops.push({ op: 'hide_section', section });
        else if (/\b(show|add back|bring back|turn on|include)\b/.test(clause)) ops.push({ op: 'show_section', section });
        const move = clause.match(/\bmove\b.*\b(up|down|higher|lower|above|below)\b/);
        if (move && clause.search(re) < clause.search(/\b(up|down|higher|lower|above|below)\b/)) {
          ops.push({ op: 'move_section', section, direction: /up|higher|above/.test(move[1]!) ? 'up' : 'down' });
        }
      }
    }
    return { operations: ops, needsInput };
  }
}
