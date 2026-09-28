// Meridian 1's renderer (Slice 5), frozen. Versions built with Meridian 1 are re-rendered with
// exactly this code, so their stored artifacts still verify byte for byte. Do not change its
// output; new work renders with Meridian 2 (render.ts).
//
// The deterministic renderer. One function turns a valid site document (plus the bytes of the
// project images it places) into one self-contained HTML file: no scripts, no external requests,
// no timestamps, every text value escaped, every link built from a validated contact target and
// every colour from the template or a checked #rrggbb value. The same document and images always
// give the same bytes, so a version's artifact hash identifies exactly what was approved.
//
// `artifact` mode is what is stored and shown: empty slots are left out. `editor` mode is the
// Build Workspace's live preview: empty slots show a placeholder, and the selected section is
// outlined. Neither mode is ever stored in editor form.
import type { Item, Section, SiteDocument } from './document.js';
import { assertValidDocument } from './operations.js';
import { type RenderImage, type RenderOptions, ctaHref, esc, luminance, monthYear, paragraphs, sourceLabel } from './render-shared.js';
import { type SiteTemplate, sectionSpec } from './template.js';

function themeVars(doc: SiteDocument, t: SiteTemplate): string {
  const p = t.palettes.find((x) => x.key === doc.theme.palette)!;
  const f = t.fonts.find((x) => x.key === doc.theme.fonts)!;
  const accent = doc.theme.accent ?? p.accent;
  const accentInk = doc.theme.accent ? (luminance(accent) > 0.4 ? '#111111' : '#ffffff') : p.accentInk;
  const v: Record<string, string> = {
    '--bg': p.bg, '--surface': p.surface, '--ink': p.ink, '--muted': p.muted, '--line': p.line, '--accent': accent, '--accent-ink': accentInk,
    '--band': p.band, '--band-ink': p.bandInk, '--font-head': f.heading, '--font-body': f.body, '--head-weight': String(f.headingWeight),
    '--tracking': f.tracking,
  };
  return Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';');
}

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
a{color:inherit}
.wrap{width:min(1160px,100% - 48px);margin-inline:auto}
h1,h2,h3{font-family:var(--font-head);font-weight:var(--head-weight);letter-spacing:var(--tracking);line-height:1.08;margin:0}
h2{font-size:clamp(1.9rem,3.6vw,2.8rem)}
h3{font-size:1.2rem;line-height:1.25}
p{margin:0 0 1em}
.eyebrow{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:600;margin:0 0 1.1rem}
.lede{font-size:clamp(1.05rem,1.6vw,1.25rem);color:var(--muted);max-width:36ch}
.btn{display:inline-flex;align-items:center;gap:.6em;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;
  padding:.95em 1.5em;border-radius:999px;font-size:1rem;line-height:1;border:0;transition:transform .15s ease,box-shadow .15s ease}
.btn:hover{transform:translateY(-1px);box-shadow:0 10px 24px -12px var(--accent)}
.btn::after{content:"\\2192";font-weight:400}
.btn.is-unset{opacity:.55;cursor:default}
.btn.sm{padding:.7em 1.1em;font-size:.9rem}
.link{color:var(--ink);font-weight:600;text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:2px}
.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 0}
.wordmark{font-family:var(--font-head);font-weight:var(--head-weight);font-size:1.25rem;letter-spacing:var(--tracking);text-decoration:none}
section{padding:clamp(64px,9vw,120px) 0}
.hero{padding-top:clamp(24px,4vw,56px)}
.hero h1{font-size:clamp(2.6rem,6.2vw,5rem);margin-bottom:1.4rem}
.hero .actions{display:flex;flex-wrap:wrap;align-items:center;gap:22px;margin-top:2rem}
.hero-split .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:clamp(32px,5vw,72px);align-items:center}
.visual{position:relative;border-radius:28px;overflow:hidden;aspect-ratio:4/5;background:var(--surface);border:1px solid var(--line)}
.visual img{width:100%;height:100%;object-fit:cover}
.monogram{position:absolute;inset:0;display:grid;place-items:center;
  background:radial-gradient(120% 90% at 20% 10%,color-mix(in srgb,var(--accent) 28%,transparent),transparent 60%),
    radial-gradient(90% 80% at 90% 100%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 60%),var(--surface)}
.monogram span{font-family:var(--font-head);font-size:clamp(7rem,16vw,12rem);color:var(--accent);opacity:.9;line-height:1}
.hero-centered{text-align:center}
.hero-centered .lede{margin-inline:auto}
.hero-centered .actions{justify-content:center}
.hero-centered .visual{aspect-ratio:21/9;margin-top:clamp(40px,6vw,72px)}
.hero-banner{position:relative;background:var(--band);color:var(--band-ink);padding:0 0 clamp(96px,13vw,170px);overflow:hidden}
.hero-banner .nav{position:relative}
.hero-banner .lift{margin-top:clamp(56px,10vw,130px)}
.hero-banner .bg{position:absolute;inset:0}
.hero-banner .bg img{width:100%;height:100%;object-fit:cover;opacity:.38}
.hero-banner .wrap{position:relative}
.hero-banner .wordmark{color:var(--band-ink)}
.hero-banner .lede{color:color-mix(in srgb,var(--band-ink) 78%,transparent)}
.hero-banner .link{color:var(--band-ink);border-color:color-mix(in srgb,var(--band-ink) 30%,transparent)}
.head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:clamp(32px,5vw,56px);flex-wrap:wrap}
.head p{color:var(--muted);max-width:44ch;margin:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:28px 26px 30px}
.card .n{font-size:.8rem;color:var(--accent);font-weight:700;letter-spacing:.1em;margin-bottom:28px;display:block}
.card p{color:var(--muted);margin:.6em 0 0}
.about .grid{display:grid;grid-template-columns:1fr 1fr;gap:clamp(32px,6vw,88px);align-items:center}
.about .grid.solo{grid-template-columns:minmax(0,760px)}
.about .body{font-size:1.1rem}
.about .rule{width:56px;height:3px;background:var(--accent);border-radius:3px;margin:22px 0 26px}
.about .visual{aspect-ratio:5/4}
.proof{background:var(--surface);border-block:1px solid var(--line)}
.proof .grid{display:grid;grid-template-columns:auto 1fr;gap:clamp(28px,6vw,80px);align-items:center}
.score{font-family:var(--font-head);font-size:clamp(4.5rem,11vw,8rem);line-height:.9;color:var(--accent)}
.score small{display:block;font-family:var(--font-body);font-size:1rem;color:var(--muted);margin-top:12px}
.source{color:var(--muted);font-size:.92rem;margin-top:14px}
.gallery .grid{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:220px;gap:14px}
.gallery figure{margin:0;border-radius:18px;overflow:hidden;background:var(--surface)}
.gallery figure:first-child{grid-row:span 2}
.gallery img{width:100%;height:100%;object-fit:cover}
.contact{background:var(--band);color:var(--band-ink)}
.contact .grid{display:grid;grid-template-columns:1.2fr .8fr;gap:clamp(32px,6vw,80px);align-items:start}
.contact .lede{color:color-mix(in srgb,var(--band-ink) 75%,transparent)}
.contact .btn{margin-top:1.6rem}
.contact dl{margin:0;display:grid;gap:18px}
.contact dt{font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:color-mix(in srgb,var(--band-ink) 60%,transparent)}
.contact dd{margin:4px 0 0;font-size:1.05rem}
.footer{padding:36px 0 44px;color:var(--muted);font-size:.9rem}
.footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:28px}
.mobile-cta{display:none}
.ph{border:1.5px dashed color-mix(in srgb,var(--ink) 28%,transparent);border-radius:14px;padding:14px 16px;color:var(--muted);font-size:.95rem;background:color-mix(in srgb,var(--surface) 70%,transparent)}
.contact .ph,.hero-banner .ph{color:color-mix(in srgb,var(--band-ink) 70%,transparent);border-color:color-mix(in srgb,var(--band-ink) 35%,transparent);background:transparent}
[data-selected]{outline:3px solid #4f7cff;outline-offset:-3px}
@media (max-width:960px){
  .hero-split .grid,.about .grid,.contact .grid{grid-template-columns:1fr}
  .hero-split .visual{aspect-ratio:4/3;order:-1}
  .gallery .grid{grid-template-columns:repeat(2,1fr);grid-auto-rows:180px}
}
@media (max-width:720px){
  body{font-size:16px;padding-bottom:84px}
  .wrap{width:calc(100% - 36px)}
  .nav .btn{display:none}
  .proof .grid{grid-template-columns:1fr}
  .gallery .grid{grid-template-columns:1fr 1fr;grid-auto-rows:140px}
  .mobile-cta{display:flex;position:fixed;left:12px;right:12px;bottom:12px;z-index:10;justify-content:center;
    box-shadow:0 18px 40px -18px rgba(0,0,0,.55)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`.replace(/\n\s*/g, '');

/**
 * Renders a site. Throws if the document is not valid for its template or places an image whose
 * bytes were not supplied.
 */
export function renderSiteV1(doc: SiteDocument, t: SiteTemplate, images: ReadonlyMap<string, RenderImage>, opts: RenderOptions): string {
  assertValidDocument(doc, t);
  const editor = opts.mode === 'editor';
  const ph = (text: string) => (editor ? `<div class="ph">${esc(text)}</div>` : '');
  const img = (id: string | null | undefined, cls = '') => {
    if (!id) return '';
    const i = images.get(id);
    if (!i) throw new Error('an image placed on the site is not available');
    return `<img${cls ? ` class="${cls}"` : ''} src="data:${i.contentType};base64,${i.bytes.toString('base64')}" alt="${esc(i.alt)}">`;
  };
  const href = ctaHref(doc.cta.action);
  const cta = (extra = '') => href
    ? `<a class="btn${extra}" href="${esc(href)}"${doc.cta.action.kind === 'link' || doc.cta.action.kind === 'whatsapp' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(doc.cta.label)}</a>`
    // A button that goes nowhere is the defect the build answers, so the artifact leaves it out; only the editor shows it.
    : editor ? `<span class="btn is-unset${extra}" title="Add a destination for this button">${esc(doc.cta.label)}</span>` : '';
  const visible = doc.sections.filter((s) => s.visible);
  const has = (type: string) => visible.some((s) => s.type === type);
  const attrs = (s: Section) => ` id="s-${s.type}" data-section="${s.type}"${editor && opts.selected === s.type ? ' data-selected' : ''}`;
  const txt = (s: Section, k: string) => String(s.content[k] ?? '');
  const brand = doc.brand.name;
  const initial = esc([...brand.trim()][0]?.toUpperCase() ?? '');

  const parts: string[] = [];
  for (const s of visible) {
    const spec = sectionSpec(t, s.type);
    switch (s.type) {
      case 'hero': {
        const eyebrow = txt(s, 'eyebrow') ? `<p class="eyebrow">${esc(txt(s, 'eyebrow'))}</p>` : ph('Optional: a short line about what the business does');
        const sub = txt(s, 'subheadline') ? `<p class="lede">${esc(txt(s, 'subheadline'))}</p>` : '';
        const second = has('services') ? `<a class="link" href="#s-services">${esc(txt(doc.sections.find((x) => x.type === 'services')!, 'heading') || 'What we offer')}</a>` : '';
        const text = `${eyebrow}<h1>${esc(txt(s, 'headline'))}</h1>${sub}<div class="actions">${cta()}${second}</div>`;
        const picture = img(s.content.image as string | null);
        const nav = `<header class="wrap nav"><a class="wordmark" href="#top">${esc(brand)}</a>${cta(' sm')}</header>`;
        if (s.variant === 'banner') {
          parts.push(`<div id="top"></div><section class="hero hero-banner"${attrs(s)}>${picture ? `<div class="bg">${picture}</div>` : ''}${nav}<div class="wrap lift">${text}</div></section>`);
        } else if (s.variant === 'centered') {
          parts.push(`<div id="top"></div>${nav}<section class="hero hero-centered"${attrs(s)}><div class="wrap">${text}${picture ? `<div class="visual">${picture}</div>` : ''}</div></section>`);
        } else {
          const visual = `<div class="visual">${picture || `<div class="monogram" aria-hidden="true"><span>${initial}</span></div>`}</div>`;
          parts.push(`<div id="top"></div>${nav}<section class="hero hero-split"${attrs(s)}><div class="wrap grid"><div>${text}</div>${visual}</div></section>`);
        }
        break;
      }
      case 'services': {
        const items = s.content.items as Item[];
        const cards = items.length
          ? items.map((it, i) => `<article class="card"><span class="n">${String(i + 1).padStart(2, '0')}</span><h3>${esc(it.title)}</h3>${it.text ? `<p>${esc(it.text)}</p>` : ''}</article>`).join('')
          : editor ? [1, 2, 3].map(() => `<article class="card">${ph('Add a service the business offers')}</article>`).join('') : '';
        if (!cards) break;
        parts.push(`<section class="services"${attrs(s)}><div class="wrap"><div class="head"><h2>${esc(txt(s, 'heading'))}</h2>${txt(s, 'intro') ? `<p>${esc(txt(s, 'intro'))}</p>` : ''}</div><div class="cards">${cards}</div></div></section>`);
        break;
      }
      case 'about': {
        const body = txt(s, 'body') ? `<div class="body">${paragraphs(txt(s, 'body'))}</div>` : ph('Add a few sentences about the business');
        if (!txt(s, 'body') && !editor) break;
        const picture = img(s.content.image as string | null);
        parts.push(`<section class="about"${attrs(s)}><div class="wrap grid${picture ? '' : ' solo'}"><div><h2>${esc(txt(s, 'heading'))}</h2><div class="rule"></div>${body}</div>${picture ? `<div class="visual">${picture}</div>` : ''}</div></section>`);
        break;
      }
      case 'proof': {
        const r = doc.facts.reviews;
        if (!r) { if (editor) parts.push(`<section class="proof"${attrs(s)}><div class="wrap">${ph('No sourced review data. This section stays empty.')}</div></section>`); break; }
        const when = monthYear(r.asOf);
        const score = r.rating !== null ? `<div class="score">${esc(r.rating)}<small>out of 5</small></div>` : `<div class="score">${esc(r.count)}<small>reviews</small></div>`;
        const line = [r.count !== null && r.rating !== null ? `From ${esc(r.count)} reviews` : null, `on ${esc(sourceLabel(r.source))}`, when ? `as of ${esc(when)}` : null].filter(Boolean).join(' ');
        parts.push(`<section class="proof"${attrs(s)}><div class="wrap grid">${score}<div><h2>${esc(txt(s, 'heading'))}</h2><p class="source">${line}.</p></div></div></section>`);
        break;
      }
      case 'gallery': {
        const ids = s.content.images as string[];
        if (!ids.length) { if (editor) parts.push(`<section class="gallery"${attrs(s)}><div class="wrap"><div class="head"><h2>${esc(txt(s, 'heading'))}</h2></div>${ph('Add real photos of the work or the place')}</div></section>`); break; }
        parts.push(`<section class="gallery"${attrs(s)}><div class="wrap"><div class="head"><h2>${esc(txt(s, 'heading'))}</h2></div><div class="grid">${ids.map((id) => `<figure>${img(id)}</figure>`).join('')}</div></div></section>`);
        break;
      }
      case 'contact': {
        const details = s.content.details as Item[];
        const dl = details.length ? `<dl>${details.map((d) => `<div><dt>${esc(d.title)}</dt><dd>${esc(d.text)}</dd></div>`).join('')}</dl>`
          : ph('Add details such as opening hours or the area served, if you know them');
        parts.push(`<section class="contact"${attrs(s)}><div class="wrap grid"><div><h2>${esc(txt(s, 'heading'))}</h2>${txt(s, 'body') ? `<p class="lede" style="margin-top:1.2rem">${esc(txt(s, 'body'))}</p>` : ''}${cta()}${!href ? ph('Add where this button goes: phone, WhatsApp, email or a link') : ''}</div><div>${dl}</div></div></section>`);
        break;
      }
      case 'footer': {
        parts.push(`<footer class="footer"${attrs(s)}><div class="wrap"><span>&copy; ${esc(brand)}</span>${txt(s, 'note') ? `<span>${esc(txt(s, 'note'))}</span>` : ''}</div></footer>`);
        break;
      }
    }
  }
  if (href || editor) parts.push(`<div class="mobile-cta">${cta()}</div>`);

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + `<meta name="generator" content="Scopely ${esc(t.name)} template v${t.version}">`
    + `<title>${esc(brand)}</title>`
    + `<style>:root{${themeVars(doc, t)}}${CSS}</style></head><body>${parts.join('')}</body></html>`;
}
