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
  [/\bservices?\b|\bofferings?\b|\btreatments?\b/, 'services'],
  [/\babout\b/, 'about'],
  [/\breviews?\b|\bratings?\b|\bproof\b|\btestimonials?\b/, 'proof'],
  [/\bgallery\b|\bphotos?\b|\bimages?\b|\bpictures?\b/, 'gallery'],
  [/\bcall[- ]to[- ]action (band|section)\b|\bcta (band|section)\b/, 'cta'],
  [/\bcontact\b/, 'contact'],
];

// Copy is taken from double quotes, so an apostrophe inside it ("we're") is kept.
const quoted = (s: string, after: RegExp, max = 900): string | null => {
  const m = s.match(new RegExp(`${after.source}[^"“”]{0,40}["“]([^"“”]{1,${max}})["”]`, 'i'));
  return m ? m[m.length - 1]!.trim() : null;
};

// Where copy in a request goes. The first match wins, so more specific names come first.
const COPY_TARGETS: [RegExp, string, string][] = [
  [/\b(supporting line|sub-?headline|sub-?heading|subtitle|hero text)\b/, 'hero', 'subheadline'],
  [/\bheadline\b/, 'hero', 'headline'],
  [/\b(tagline|eyebrow)\b/, 'hero', 'eyebrow'],
  [/\bservices? (intro|introduction|text|copy)\b/, 'services', 'intro'],
  [/\bservices? heading\b/, 'services', 'heading'],
  [/\babout (heading|title)\b/, 'about', 'heading'],
  [/\babout( us)? (text|copy|section|paragraph|body)\b/, 'about', 'body'],
  [/\bcontact (heading|title)\b/, 'contact', 'heading'],
  [/\bcontact (text|copy|section|body)\b/, 'contact', 'body'],
  [/\bfooter( note| line| text)?\b/, 'footer', 'note'],
];

const numberIn = (s: string): string | null => {
  const m = s.match(/\+?[0-9][0-9\s().-]{6,}[0-9]/);
  return m ? m[0] : null;
};

/**
 * A deterministic interpreter: a fixed vocabulary of style, layout, section, button and copy
 * requests. Copy comes from the request's quotes and lands in the slot the request names; a
 * model-backed interpreter would draft it instead, through the same checks. It never supplies a
 * contact detail the person did not write in the request.
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

    // Look and feel (Meridian 2's palettes, pairings, layouts and style controls).
    const premium = /\b(premium|luxur(y|ious)|elegant|upscale|high[- ]end|sophisticated|refined|classy)\b/.test(r);
    if (premium) {
      palette('noir');
      ops.push({ op: 'change_font', fonts: 'editorial' });
      if (/\bhero\b|\btop\b|\bheader\b/.test(r) || !/\b(section|services|about|gallery|contact)\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'centered' });
    } else if (/\b(minimal|clean|simple|light(er)?|neutral|calm)\b/.test(r)) { palette('stone'); ops.push({ op: 'change_font', fonts: 'modern' }); }
    else if (/\b(warm(er)?|friendly|welcoming|soft(er)?|pink|terracotta|blush)\b/.test(r)) palette('blush');
    else if (/\b(green|natural|fresh|organic|sage)\b/.test(r)) palette('sage');
    else if (/\b(dark(er)?|moody|night|noir)\b/.test(r)) palette('noir');
    if (!premium) {
      if (/\bserif\b|\bclassic(al)?\b|\btraditional\b/.test(r) && !/\bsans\b/.test(r)) ops.push({ op: 'change_font', fonts: /\bclassic|traditional/.test(r) ? 'classic' : 'editorial' });
      else if (/\bsans\b|\bmodern\b/.test(r)) ops.push({ op: 'change_font', fonts: 'modern' });
    }
    const hex = r.match(/#[0-9a-f]{6}\b/);
    if (hex && /\b(accent|colou?r|button)\b/.test(r)) ops.push({ op: 'change_color', accent: hex[0] });
    if (!premium) {
      if (/\bcent(er|re)d?\b/.test(r) && /\bhero\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'centered' });
      else if (/\bsplit\b|\bside by side\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'split' });
      else if (/\b(bold|dramatic|big(ger)? hero)\b/.test(r)) ops.push({ op: 'change_layout', section: 'hero', variant: 'centered' });
    }
    const style: Record<string, string> = {};
    if (/\b(pill|round(ed)?) buttons?\b|\bbuttons? (more )?(round(ed)?|pill)/.test(r)) style.button = /pill/.test(r) ? 'pill' : 'rounded';
    else if (/\b(square|sharp)( |-)?(cornered )?buttons?\b|\bbuttons? (more )?(square|sharp)/.test(r)) style.button = 'square';
    if (/\b(more space|more room|spacious|airy|breathing room)\b/.test(r)) style.spacing = 'airy';
    else if (/\b(compact|tighter|less space|denser)\b/.test(r)) style.spacing = 'compact';
    if (/\barch(ed|es)?\b/.test(r)) style.image = 'arch';
    else if (/\b(square|sharp)( |-)?(cornered )?(images?|photos?|pictures?)\b/.test(r)) style.image = 'square';
    else if (/\b(soft|rounded) (images?|photos?|pictures?)\b/.test(r)) style.image = 'soft';
    if (/\balternat(e|ing) (section )?backgrounds?\b|\bstripe/.test(r)) style.backgrounds = 'alternate';
    else if (/\bplain backgrounds?\b|\bsame background\b/.test(r)) style.backgrounds = 'plain';
    if (Object.keys(style).length) ops.push({ op: 'change_style', ...style });

    // The main button.
    const aboutButton = /\b(cta|button|call to action)\b/.test(r);
    const label = quoted(request, /(?:cta|button|call to action)/, 60);
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

    // Copy. An AI edit may rewrite any text slot and service description (A16); what it writes goes
    // through the claim check in operations.ts like any other AI text.
    for (const [re, section, slot] of COPY_TARGETS) {
      const text = quoted(request, re);
      if (text && !ops.some((o) => (o as { section?: string; slot?: string }).section === section && (o as { slot?: string }).slot === slot)) {
        ops.push({ op: 'update_text', section, slot, value: text });
      }
    }
    // A service description: describe "Sports rehab" as "…"
    const services = document.sections.find((x) => x.type === 'services');
    const items = ((services?.content.items ?? []) as { title: string; text: string }[]).map((i) => ({ ...i }));
    let described = false;
    for (const m of request.matchAll(/describe\s+(?:the\s+)?["“]([^"“”]{1,80})["”]\s+(?:service\s+)?as\s+["“]([^"“”]{1,200})["”]/gi)) {
      const item = items.find((i) => i.title.trim().toLowerCase() === m[1]!.trim().toLowerCase());
      if (item) { item.text = m[2]!.trim(); described = true; }
      else needsInput.push(`There is no service called "${m[1]!.trim()}". Add it in the editor first; an AI edit cannot add services.`);
    }
    if (described) ops.push({ op: 'update_items', section: 'services', slot: 'items', items });

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
