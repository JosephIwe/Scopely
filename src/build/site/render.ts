// The deterministic renderer. One function turns a valid site document (plus the bytes of the
// project images it places) into one self-contained HTML file: no scripts, no external requests,
// no timestamps, every text value escaped, every link built from a validated contact target and
// every colour from the template or a checked #rrggbb value. The same document and images always
// give the same bytes, so a version's artifact hash identifies exactly what was approved.
//
// Meridian 2 (the Slice 6 "Modern Clinic" restyle) renders here. The typefaces its pairing needs
// are embedded as data: URLs (fonts.ts). A Meridian 1 document is rendered by the frozen
// render-v1.ts, so versions made before Slice 6 keep their exact bytes.
//
// `artifact` mode is what is stored and shown: empty slots are left out, and the layout follows
// real media queries. `editor` mode is the Build Workspace's live preview: empty slots show a
// placeholder, sections carry hover, selected and changed rings with a name chip, and the layout
// follows a `dev-desktop` / `dev-tablet` / `dev-mobile` class on <body> that the workspace sets
// from its device switcher (the same rules, scoped by class instead of width). Neither mode is
// ever stored in editor form.
import type { Item, Section, SiteDocument } from './document.js';
import { embeddedFontFaces } from './fonts.js';
import { assertValidDocument } from './operations.js';
import { type RenderImage, type RenderOptions, ctaHref, esc, luminance, monthYear, paragraphs, sourceLabel } from './render-shared.js';
import { renderSiteV1 } from './render-v1.js';
import { type Palette, type SiteTemplate, sectionSpec } from './template.js';

export { type RenderImage, type RenderOptions, ctaHref } from './render-shared.js';

const BUTTON_RADIUS: Record<string, string> = { rounded: '10px', pill: '999px', square: '0px' };
const SPACE: Record<string, string> = { compact: '.72', comfortable: '1', airy: '1.28' };
const IMAGE_RADIUS: Record<string, string> = { soft: '18px', square: '0px', arch: '999px 999px 18px 18px' };

function themeVars(doc: SiteDocument, t: SiteTemplate): string {
  const p = t.palettes.find((x) => x.key === doc.theme.palette)!;
  const f = t.fonts.find((x) => x.key === doc.theme.fonts)!;
  const accent = doc.theme.accent ?? p.accent;
  const accentInk = doc.theme.accent ? (luminance(accent) > 0.4 ? '#111111' : '#ffffff') : p.accentInk;
  const v: Record<string, string> = {
    '--bg': p.bg, '--surface': p.surface, '--ink': p.ink, '--muted': p.muted, '--line': p.line, '--tint': p.tint ?? p.surface,
    '--accent': accent, '--accent-ink': accentInk, '--font-head': f.heading, '--font-body': f.body, '--head-weight': String(f.headingWeight),
    '--tracking': f.tracking, '--scale': String(f.scale ?? 1), '--space': SPACE[doc.theme.spacing!]!, '--btn-r': BUTTON_RADIUS[doc.theme.button!]!,
    '--card-r': doc.theme.button === 'square' ? '0px' : '16px', '--img-r': IMAGE_RADIUS[doc.theme.image!]!,
  };
  return Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';');
}

const BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
a{color:inherit}
p{margin:0}
.wrap{width:100%;max-width:1312px;margin-inline:auto;padding-inline:64px}
h1,h2,h3{font-family:var(--font-head);font-weight:var(--head-weight);letter-spacing:var(--tracking);margin:0;text-wrap:balance}
h1{font-size:calc(68px * var(--scale));line-height:1.02}
h2{font-size:calc(44px * var(--scale));line-height:1.08}
h3{font-size:calc(20px * var(--scale));line-height:1.25}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.lede{font-size:18px;line-height:1.55;color:var(--muted);max-width:540px;text-wrap:pretty}
.muted{color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5em;padding:14px 22px;border-radius:var(--btn-r);background:var(--accent);color:var(--accent-ink);
  font-size:15px;font-weight:500;line-height:1.2;text-decoration:none;border:1px solid var(--accent);transition:filter .15s ease}
.btn:hover{filter:brightness(1.06)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.sm{padding:9px 16px;font-size:14px}
.btn.is-unset{opacity:.55;cursor:default}
.site-nav{border-bottom:1px solid var(--line);background:var(--bg)}
.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:18px}
.wordmark{font-family:var(--font-head);font-weight:var(--head-weight);letter-spacing:var(--tracking);font-size:22px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.links{display:flex;align-items:center;gap:22px;font-size:14px;color:var(--muted)}
.links a{text-decoration:none}
.links a:hover{color:var(--ink)}
.menu{display:none;position:relative}
.menu summary{list-style:none;cursor:pointer;display:flex;flex-direction:column;gap:4px;padding:8px 0}
.menu summary::-webkit-details-marker{display:none}
.menu summary span{display:block;width:20px;height:1.5px;background:var(--ink)}
.menu-panel{position:absolute;right:0;top:40px;z-index:20;min-width:200px;display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:var(--card-r);
  background:var(--surface);border:1px solid var(--line);box-shadow:0 20px 40px -24px rgba(0,0,0,.4)}
.menu-panel a{text-decoration:none}
.sec{position:relative;padding-block:calc(100px * var(--space))}
.sec.tint{background:var(--tint)}
.hero .grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:56px;align-items:center}
.hero .text{display:flex;flex-direction:column;gap:20px;align-items:flex-start}
.hero h1{max-width:640px}
.hero .actions{display:flex;gap:10px;flex-wrap:wrap}
.visual{position:relative;border-radius:var(--img-r);overflow:hidden;background:repeating-linear-gradient(135deg,var(--tint) 0 14px,var(--line) 14px 15px)}
.visual img{width:100%;height:100%;object-fit:cover}
.hero .visual{height:480px}
.monogram{position:absolute;inset:0;display:grid;place-items:center;font-family:var(--font-head);font-weight:var(--head-weight);font-size:calc(150px * var(--scale));color:var(--accent);opacity:.85;line-height:1}
.hero.centered .grid{grid-template-columns:minmax(0,1fr)}
.hero.centered .text{align-items:center;text-align:center}
.hero.centered h1{max-width:820px}
.hero.centered .actions{justify-content:center}
.hero.centered .visual{height:420px}
.head{display:flex;flex-direction:column;gap:12px;max-width:620px;margin-bottom:36px}
.head p{font-size:15.5px;color:var(--muted);line-height:1.55}
.services .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--card-r);overflow:hidden}
.services .item{display:flex;flex-direction:column;gap:10px;padding:24px;background:var(--surface)}
.services .item p{font-size:14px;color:var(--muted);line-height:1.5}
.about .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:56px;align-items:center}
.about .grid.solo{grid-template-columns:minmax(0,760px)}
.about .visual{height:440px}
.about .text{display:flex;flex-direction:column;gap:18px}
.about .body{font-size:16px;line-height:1.65;color:var(--muted);display:flex;flex-direction:column;gap:1em}
.proof .row{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
.score{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.score b{font-family:var(--font-head);font-weight:var(--head-weight);font-size:44px;line-height:1}
.score span{font-size:14px;color:var(--muted)}
.gallery .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.gallery figure{margin:0;aspect-ratio:4/5;border-radius:var(--img-r);overflow:hidden;background:var(--tint)}
.gallery img{width:100%;height:100%;object-fit:cover}
.band{display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px;padding:64px 40px;border-radius:var(--card-r);background:var(--accent);color:var(--accent-ink)}
.band p{font-size:16px;opacity:.85;max-width:460px}
.band .btn{background:var(--accent-ink);color:var(--accent);border-color:var(--accent-ink);font-weight:600;padding:14px 24px}
.contact .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:56px;align-items:start}
.contact .text{display:flex;flex-direction:column;gap:22px;align-items:flex-start}
.contact dl{margin:0;display:grid;grid-template-columns:110px 1fr;gap:14px 16px;font-size:15px}
.contact dt{color:var(--muted);font-size:13px;padding-top:2px}
.contact dd{margin:0}
.footer{padding-block:28px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.footer .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px 24px;flex-wrap:wrap}
.footer .wordmark{font-size:17px;color:var(--ink)}
.mobile-cta{display:none}
.ph{border:1.5px dashed color-mix(in srgb,var(--ink) 28%,transparent);border-radius:12px;padding:12px 14px;color:var(--muted);font-size:14px;background:color-mix(in srgb,var(--surface) 70%,transparent)}
.band .ph{color:inherit;border-color:currentColor;background:transparent;opacity:.8}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

// The responsive rules, written once and applied either by width (artifact) or by the device
// class the workspace sets (editor).
const TABLET = `
.wrap{padding-inline:40px}
.sec{padding-block:calc(76px * var(--space))}
h1{font-size:calc(54px * var(--scale))}
h2{font-size:calc(36px * var(--scale))}
.services .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
`;
const MOBILE = `
body{padding-bottom:84px}
.wrap{padding-inline:22px}
.sec{padding-block:calc(56px * var(--space))}
h1{font-size:calc(40px * var(--scale))}
h2{font-size:calc(30px * var(--scale))}
.lede{font-size:16px}
.links{display:none}
.menu{display:block}
.hero .grid,.about .grid,.contact .grid{grid-template-columns:minmax(0,1fr);gap:32px}
.hero .visual,.hero.centered .visual{height:280px}
.about .visual{height:320px}
.services .grid{grid-template-columns:minmax(0,1fr)}
.gallery .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.band{padding:44px 22px}
.contact dl{grid-template-columns:90px 1fr}
.mobile-cta{display:flex;position:fixed;left:12px;right:12px;bottom:12px;z-index:10;box-shadow:0 18px 40px -18px rgba(0,0,0,.55)}
.mobile-cta .btn{flex:1}
`;

const scoped = (css: string, scope: string) => css.trim().split('\n').map((rule) => {
  const i = rule.indexOf('{');
  return `${rule.slice(0, i).split(',').map((sel) => `${scope} ${sel.trim()}`.replace(`${scope} body`, `body${scope}`)).join(',')}${rule.slice(i)}`;
}).join('\n');

const min = (css: string) => css.replace(/\n\s*/g, '');

const ARTIFACT_CSS = min(`${BASE}@media (max-width:1000px){${TABLET}}@media (max-width:620px){${MOBILE}}`);

const EDITOR_CSS = min(`${BASE}${scoped(TABLET, '.dev-tablet')}\n${scoped(TABLET, '.dev-mobile')}\n${scoped(MOBILE, '.dev-mobile')}
[data-section]{cursor:pointer}
[data-section]::after{content:attr(data-name);position:absolute;left:8px;top:8px;z-index:30;display:none;align-items:center;height:22px;padding:0 8px;border-radius:6px;
  background:#2C5BB4;color:#fff;font:500 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;pointer-events:none}
[data-section]:hover{outline:1px solid rgba(44,91,180,.6);outline-offset:-1px}
[data-section]:hover::after{display:flex}
[data-selected]{outline:2px solid #2C5BB4!important;outline-offset:-2px}
[data-selected]::after{display:flex}
[data-changed]{outline:2px solid #D98E3A!important;outline-offset:-2px}
[data-changed]::after{display:flex;content:"Changed · " attr(data-name);background:#D98E3A;color:#1B1A18}
`);

const sectionNames = (t: SiteTemplate) => Object.fromEntries(t.sections.map((s) => [s.type, s.name]));

/**
 * Renders a site with the template version it was made with. Throws if the document is not valid
 * for its template or places an image whose bytes were not supplied.
 */
export function renderSite(doc: SiteDocument, t: SiteTemplate, images: ReadonlyMap<string, RenderImage>, opts: RenderOptions): string {
  if (t.version === 1) return renderSiteV1(doc, t, images, opts);
  assertValidDocument(doc, t);
  const editor = opts.mode === 'editor';
  const names = sectionNames(t);
  const ph = (text: string) => (editor ? `<div class="ph">${esc(text)}</div>` : '');
  const img = (id: string | null | undefined) => {
    if (!id) return '';
    const i = images.get(id);
    if (!i) throw new Error('an image placed on the site is not available');
    return `<img src="data:${i.contentType};base64,${i.bytes.toString('base64')}" alt="${esc(i.alt)}">`;
  };
  const href = ctaHref(doc.cta.action);
  const external = doc.cta.action.kind === 'link' || doc.cta.action.kind === 'whatsapp';
  const cta = (cls = 'btn') => href
    ? `<a class="${cls}" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(doc.cta.label)}</a>`
    // A button that goes nowhere is the defect the build answers, so the artifact leaves it out; only the editor shows it.
    : editor ? `<span class="${cls} is-unset" title="Add a destination for this button">${esc(doc.cta.label)}</span>` : '';
  const visible = doc.sections.filter((s) => s.visible);
  const byType = (type: string) => visible.find((s) => s.type === type);
  const txt = (s: Section | undefined, k: string) => String(s?.content[k] ?? '');
  const alternate = doc.theme.backgrounds === 'alternate';
  const attrs = (s: Section, i: number, cls: string) => ` class="sec ${cls}${alternate && i % 2 ? ' tint' : ''}" id="s-${s.type}" data-section="${s.type}"`
    + (editor ? ` data-name="${esc(names[s.type])}"${opts.selected === s.type ? ' data-selected' : ''}` : '');
  const brand = doc.brand.name;
  const initial = esc([...brand.trim()][0]?.toUpperCase() ?? '');

  // Site header: brand, links to the sections that are shown, and the main button.
  const navLinks = (['services', 'about', 'proof', 'contact'] as const).filter((k) => byType(k))
    .map((k) => `<a href="#s-${k}">${esc(txt(byType(k), 'heading') || names[k])}</a>`);
  const nav = `<header class="site-nav" id="top"><div class="wrap nav"><a class="wordmark" href="#top">${esc(brand)}</a>`
    + `<nav class="links" aria-label="Sections">${navLinks.join('')}${cta('btn sm')}</nav>`
    + `<details class="menu"><summary aria-label="Menu"><span></span><span></span></summary><div class="menu-panel">${navLinks.join('')}${cta('btn sm')}</div></details>`
    + '</div></header>';

  const parts: string[] = [nav];
  visible.forEach((s, i) => {
    switch (s.type) {
      case 'hero': {
        const centered = s.variant === 'centered';
        const eyebrow = txt(s, 'eyebrow') ? `<p class="eyebrow">${esc(txt(s, 'eyebrow'))}</p>` : ph('Optional: a short line about what the business does');
        const sub = txt(s, 'subheadline') ? `<p class="lede">${esc(txt(s, 'subheadline'))}</p>` : '';
        const services = byType('services');
        const second = services ? `<a class="btn ghost" href="#s-services">${esc(txt(services, 'heading') || 'What we offer')}</a>` : '';
        const actions = cta() || second ? `<div class="actions">${cta()}${second}</div>` : '';
        const picture = img(s.content.image as string | null);
        const visual = picture ? `<div class="visual">${picture}</div>`
          : centered ? '' : `<div class="visual" aria-hidden="true"><div class="monogram">${initial}</div></div>`;
        parts.push(`<section${attrs(s, i, `hero${centered ? ' centered' : ''}`)}><div class="wrap grid"><div class="text">${eyebrow}<h1>${esc(txt(s, 'headline'))}</h1>${sub}${actions}</div>${visual}</div></section>`);
        break;
      }
      case 'services': {
        const items = s.content.items as Item[];
        const cards = items.length
          ? items.map((it) => `<div class="item"><h3>${esc(it.title)}</h3>${it.text ? `<p>${esc(it.text)}</p>` : ''}</div>`).join('')
          : editor ? [1, 2, 3].map(() => `<div class="item">${ph('Add a service the business offers')}</div>`).join('') : '';
        if (!cards) break;
        parts.push(`<section${attrs(s, i, 'services')}><div class="wrap"><div class="head"><h2>${esc(txt(s, 'heading'))}</h2>${txt(s, 'intro') ? `<p>${esc(txt(s, 'intro'))}</p>` : ''}</div><div class="grid">${cards}</div></div></section>`);
        break;
      }
      case 'about': {
        if (!txt(s, 'body') && !editor) break;
        const body = txt(s, 'body') ? `<div class="body">${paragraphs(txt(s, 'body'))}</div>` : ph('Add a few sentences about the business');
        const picture = img(s.content.image as string | null);
        parts.push(`<section${attrs(s, i, 'about')}><div class="wrap grid${picture ? '' : ' solo'}">${picture ? `<div class="visual">${picture}</div>` : ''}<div class="text"><p class="eyebrow">${esc(names.about)}</p><h2>${esc(txt(s, 'heading'))}</h2>${body}</div></div></section>`);
        break;
      }
      case 'proof': {
        const r = doc.facts.reviews;
        if (!r) { if (editor) parts.push(`<section${attrs(s, i, 'proof')}><div class="wrap">${ph('No sourced review data. This section stays empty.')}</div></section>`); break; }
        const when = monthYear(r.asOf);
        const line = [r.rating !== null ? 'out of 5' : 'reviews', r.count !== null && r.rating !== null ? `from ${esc(r.count)} reviews` : null,
          `on ${esc(sourceLabel(r.source))}`, when ? `as of ${esc(when)}` : null].filter(Boolean).join(' · ');
        parts.push(`<section${attrs(s, i, 'proof')}><div class="wrap row"><h2>${esc(txt(s, 'heading'))}</h2><div class="score"><b>${esc(r.rating ?? r.count)}</b><span>${line}</span></div></div></section>`);
        break;
      }
      case 'gallery': {
        const ids = s.content.images as string[];
        if (!ids.length) { if (editor) parts.push(`<section${attrs(s, i, 'gallery')}><div class="wrap"><div class="head"><h2>${esc(txt(s, 'heading'))}</h2></div>${ph('Add real photos of the work or the place')}</div></section>`); break; }
        parts.push(`<section${attrs(s, i, 'gallery')}><div class="wrap"><div class="head"><h2>${esc(txt(s, 'heading'))}</h2></div><div class="grid">${ids.map((id) => `<figure>${img(id)}</figure>`).join('')}</div></div></section>`);
        break;
      }
      case 'cta': {
        parts.push(`<section${attrs(s, i, 'cta')}><div class="wrap"><div class="band"><h2>${esc(txt(s, 'heading'))}</h2>${txt(s, 'text') ? `<p>${esc(txt(s, 'text'))}</p>` : ''}${cta()}${!href ? ph('Add where the main button goes') : ''}</div></div></section>`);
        break;
      }
      case 'contact': {
        const details = s.content.details as Item[];
        const dl = details.length ? `<dl>${details.map((d) => `<dt>${esc(d.title)}</dt><dd>${esc(d.text)}</dd>`).join('')}</dl>`
          : ph('Add details such as opening hours or the area served, if you know them');
        parts.push(`<section${attrs(s, i, 'contact')}><div class="wrap grid"><div class="text"><h2>${esc(txt(s, 'heading'))}</h2>${txt(s, 'body') ? `<p class="lede">${esc(txt(s, 'body'))}</p>` : ''}${cta()}${!href ? ph('Add where this button goes: phone, WhatsApp, email or a link') : ''}</div><div>${dl}</div></div></section>`);
        break;
      }
      case 'footer': {
        parts.push(`<footer class="footer" id="s-footer" data-section="footer"${editor ? ` data-name="${esc(names.footer)}"${opts.selected === 'footer' ? ' data-selected' : ''}` : ''}><div class="wrap"><span class="wordmark">${esc(brand)}</span>${txt(s, 'note') ? `<span>${esc(txt(s, 'note'))}</span>` : ''}<span>&copy; ${esc(brand)}</span></div></footer>`);
        break;
      }
    }
  });
  if (href || editor) parts.push(`<div class="mobile-cta">${cta()}</div>`);

  const f = t.fonts.find((x) => x.key === doc.theme.fonts)!;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + `<meta name="generator" content="Scopely ${esc(t.name)} template v${t.version}">`
    + `<title>${esc(brand)}</title>`
    + `<style>${embeddedFontFaces(f.faces ?? [])}:root{${themeVars(doc, t)}}${editor ? EDITOR_CSS : ARTIFACT_CSS}</style></head>`
    + `<body${editor ? ' class="dev-desktop"' : ''}>${parts.join('')}</body></html>`;
}

/** Palette lookup for screens (swatches). */
export const paletteOf = (t: SiteTemplate, key: string): Palette | undefined => t.palettes.find((p) => p.key === key);
