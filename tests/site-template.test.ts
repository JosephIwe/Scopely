// The template, the renderer, edit operations, the claim rules and the deterministic interpreter,
// without a database.
import { describe, expect, it } from 'vitest';
import type { BuildContext } from '../src/build/context.js';
import {
  EditRejected, MERIDIAN, RuleBasedEditInterpreter, applyEdits, claimBlocker, ctaHref, generateDocument, parseOperation, readiness, renderSite,
  websiteBuilder,
} from '../src/build/site/index.js';

function context(over: Partial<BuildContext> = {}): BuildContext {
  return {
    contextVersion: 1, purpose: 'DEMO',
    project: { projectId: '7', buildKind: 'website', opportunityPath: 'WEBSITE', storagePrefix: 'workspaces/1/projects/7/' },
    baseVersion: null,
    business: { businessId: '3', name: 'Northside Studio', domain: 'northside.test', websiteUrl: 'https://northside.test/', identitySources: [] },
    facts: [], withheldFacts: [{ attribute: 'phone', reason: 'recorded without a source or basis' }],
    opportunity: { opportunityId: '11', opportunityType: 'website_rebuild', kind: 'website' },
    catalogItem: { catalogItemId: '5', catalogKey: 'website_build', service: 'Website build', components: [] },
    evidence: [{ evidenceId: '21', issueCode: 'E-BOOK-TO-ENQUIRY', plainIssue: 'The Book button opens a general enquiry form', url: 'https://northside.test/',
      quote: '<a href="/contact">Book now</a>', observedAt: '2026-09-28T10:00:00.000Z', confidence: 'HIGH', claimState: 'OBSERVED', recheck: null }],
    notObservable: [{ observationId: '9', checkCode: 'booking_cta_trace.path', url: 'https://northside.test/', observedAt: '2026-09-28T10:00:00.000Z', state: 'NOT_OBSERVABLE' }],
    notObservableNotes: null, requirements: [], assets: [],
    ...over,
  };
}

const env = { template: MERIDIAN, imageAssetIds: new Set<string>(), origin: 'person' as const };

async function generated() {
  const ctx = context();
  return generateDocument(ctx, await websiteBuilder.instruct!(ctx), MERIDIAN);
}

describe('the Meridian template', () => {
  it('is one reusable template that names no business, seller or place', () => {
    const text = JSON.stringify(MERIDIAN);
    expect(text).not.toMatch(/joseph|lagos|london|clinic|plumb|aesthetic/i);
    expect(MERIDIAN.sections.map((s) => s.type)).toEqual(['hero', 'services', 'about', 'proof', 'gallery', 'contact', 'footer']);
    expect(MERIDIAN.sections.find((s) => s.type === 'proof')!.factBound).toBe('reviews');
  });
});

describe('generating a document', () => {
  it('is deterministic and writes no claim of its own', async () => {
    const a = await generated();
    expect(await generated()).toEqual(a);
    for (const s of a.sections) {
      for (const [slot, v] of Object.entries(s.content)) {
        if (typeof v === 'string' && a.provenance[`${s.type}.${slot}`] === 'template') expect(claimBlocker(v, a.brand.name), `${s.type}.${slot}`).toBeNull();
      }
    }
    expect(claimBlocker(a.cta.label, a.brand.name)).toBeNull();
  });

  it('answers the observed booking problem with one clear next step, and leaves what it cannot know for a person', async () => {
    const d = await generated();
    expect(d.cta.label).toBe('Make an enquiry');
    expect(d.basis.addresses).toEqual([{ evidenceIds: ['21'], change: expect.stringMatching(/One clear next step/) }]);
    expect(d.basis.notUsed).toEqual(expect.arrayContaining([{ what: 'Where the booking button leads', why: expect.stringMatching(/could not be observed/) }]));
    expect(readiness(d, MERIDIAN).map((r) => r.section)).toEqual(['cta', 'services', 'about']);
  });
});

describe('rendering', () => {
  it('gives the same bytes for the same document, and a self-contained page with no script or external request', async () => {
    const d = await generated();
    const a = renderSite(d, MERIDIAN, new Map(), { mode: 'artifact' });
    expect(renderSite(structuredClone(d), MERIDIAN, new Map(), { mode: 'artifact' })).toBe(a);
    expect(a).not.toMatch(/<script|<iframe|<object|<embed|<form|javascript:|\son[a-z]+=/i);
    expect(a).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(a).toContain('<meta name="robots" content="noindex,nofollow">');
    // Artifact mode leaves out empty slots; editor mode shows them.
    expect(a).not.toContain('class="ph"');
    expect(renderSite(d, MERIDIAN, new Map(), { mode: 'editor' })).toContain('class="ph"');
  });

  it('escapes everything a person types', async () => {
    const d = await generated();
    const attack = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const { document } = applyEdits(d, [
      { op: 'update_text', section: 'hero', slot: 'headline', value: attack },
      { op: 'update_items', section: 'services', slot: 'items', items: [{ title: '<script>alert(3)</script>', text: '</style><style>body{display:none}' }] },
      { op: 'update_cta', label: '<b>x</b>' },
    ], env);
    const html = renderSite(document, MERIDIAN, new Map(), { mode: 'artifact' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</style><style>body');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('builds links only from validated contact targets', () => {
    expect(ctaHref({ kind: 'whatsapp', value: '447700900123' })).toBe('https://wa.me/447700900123');
    expect(ctaHref({ kind: 'phone', value: '+442079460000' })).toBe('tel:+442079460000');
    expect(ctaHref({ kind: 'unset' })).toBeNull();
    for (const bad of [
      { kind: 'link', value: 'javascript:alert(1)' }, { kind: 'link', value: 'http://plain.test' }, { kind: 'link', value: 'https://user:pw@x.test' },
      { kind: 'email', value: 'a@b' }, { kind: 'email', value: '"><x>@y.com' }, { kind: 'phone', value: 'call me' }, { kind: 'whatsapp', value: '0123' },
      { kind: 'sms', value: '1' }, { kind: 'phone', value: '123456', extra: 1 },
    ]) {
      expect(() => parseOperation({ op: 'update_cta', action: bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it('leaves a button with no destination off the artifact and shows it only in the editor', async () => {
    const d = await generated();
    expect(d.cta.action).toEqual({ kind: 'unset' });
    const artifact = renderSite(d, MERIDIAN, new Map(), { mode: 'artifact' });
    expect(artifact).not.toContain(d.cta.label);
    expect(artifact).not.toContain('btn is-unset');
    expect(artifact).not.toContain('class="mobile-cta"');
    expect(renderSite(d, MERIDIAN, new Map(), { mode: 'editor' })).toContain('is-unset');
    const { document } = applyEdits(d, [{ op: 'update_cta', action: { kind: 'phone', value: '+442079460000' } }], env);
    expect(renderSite(document, MERIDIAN, new Map(), { mode: 'artifact' })).toContain('href="tel:+442079460000"');
  });
});

describe('edit operations', () => {
  it('refuse anything outside the schema and apply nothing when one edit fails', async () => {
    const d = await generated();
    for (const raw of [null, 'x', { op: 'eval' }, { op: 'update_text', section: 'hero', slot: 'headline' }, { op: 'update_text', section: 'hero', slot: 'headline', value: 1 },
      { op: 'change_color', accent: 'url(x)' }, { op: 'change_font', fonts: 'comic' }, { op: 'change_layout', section: 'services', variant: 'split' },
      { op: 'update_text', section: 'nav', slot: 'x', value: 'y' }, { op: 'update_text', section: 'hero', slot: 'headline', value: 'x'.repeat(91) },
      { op: 'update_text', section: 'hero', slot: 'headline', value: '   ' }, { op: 'set_images', section: 'gallery', slot: 'images', assetIds: ['1'] },
      { op: 'move_section', section: 'services', direction: 'up' }, { op: 'hide_section', section: 'contact' }]) {
      expect(() => applyEdits(d, [{ op: 'change_font', fonts: 'classic' }, raw], env), JSON.stringify(raw)).toThrow(EditRejected);
    }
    expect(d.theme.fonts).toBe('modern');
  });

  it('strip invisible and bidirectional control characters from text', async () => {
    const d = await generated();
    const rlo = String.fromCharCode(0x202e);
    const zw = String.fromCharCode(0x200b);
    const { document } = applyEdits(d, [{ op: 'update_text', section: 'hero', slot: 'eyebrow', value: `a${rlo}b${zw}c\u0007` }], env);
    expect(document.sections[0]!.content.eyebrow).toBe('abc');
  });
});

describe('the deterministic interpreter', () => {
  const interp = new RuleBasedEditInterpreter();
  const ask = async (request: string) => interp.interpret({ request, document: await generated(), template: MERIDIAN });

  it('maps the brief\'s example to structured operations and asks for the number it does not have', async () => {
    const r = await ask('Make the hero feel more premium and change the CTA to WhatsApp.');
    expect(r.operations).toEqual([
      { op: 'change_color', palette: 'graphite' }, { op: 'change_font', fonts: 'editorial' }, { op: 'change_layout', section: 'hero', variant: 'centered' },
      { op: 'update_cta', label: 'Message us on WhatsApp', action: { kind: 'unset' } },
    ]);
    expect(r.needsInput).toHaveLength(1);
  });

  it('understands sections, order, labels and quoted copy, and returns nothing for what it cannot map', async () => {
    expect((await ask('hide the gallery and move services down')).operations)
      .toEqual([{ op: 'hide_section', section: 'gallery' }, { op: 'move_section', section: 'services', direction: 'down' }]);
    expect((await ask('make the button say "Request a quote"')).operations).toEqual([{ op: 'update_cta', label: 'Request a quote' }]);
    expect((await ask('change the headline to "Considered skin care"')).operations)
      .toEqual([{ op: 'update_text', section: 'hero', slot: 'headline', value: 'Considered skin care' }]);
    expect(await ask('do something cool')).toEqual({ operations: [], needsInput: [] });
  });
});
