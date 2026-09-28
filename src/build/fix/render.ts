// The preview a prospect sees for a fix version: one static page (no script, no request, fonts
// embedded) that says what was observed and shows the link BEFORE, as captured, and AFTER, with
// the corrected destination. It states nothing the fix document does not hold, and it says plainly
// that the business's live website has not been changed.
import { embeddedFontFaces } from '../site/fonts.js';
import { esc } from '../site/render-shared.js';
import { describeHref } from './destination.js';
import type { FixDocument } from './document.js';

const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

const CSS = `
*{box-sizing:border-box}html,body{margin:0}
body{background:#F4F1EA;color:#1B1A18;font:15px/1.55 "Geist",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:40px 24px 56px}
.eyebrow{font:600 11px/1 "Geist",sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#2C5BB4}
h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:12px 0 8px}
.lede{color:#4F4B44;max-width:640px}
.card{background:#FBF9F4;border:1px solid #E2DCD0;border-radius:14px;padding:20px;margin-top:24px}
.label{font-size:11px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:#6F6A61}
.quote{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid #EEE9DF;border-radius:8px;padding:10px 12px;margin-top:10px;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;color:#6F6A61;font-size:13px}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px}
.side{background:#fff;border:1px solid #E2DCD0;border-radius:14px;overflow:hidden}
.side header{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #EEE9DF;font:600 11px/1 "Geist",sans-serif;letter-spacing:.1em;text-transform:uppercase}
.side.before header{color:#B5483A;background:#F7E4E0}
.side.after header{color:#2C5BB4;background:#E3EAF7}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.body{padding:18px 16px 20px}
.ctx{color:#6F6A61;font-size:13.5px;overflow-wrap:anywhere}
.lnk{display:inline-block;margin:10px 0;padding:9px 16px;border-radius:999px;font-weight:600;text-decoration:none}
.before .lnk{background:#F4F1EA;color:#1B1A18;border:1.5px dashed #B5483A}
.after .lnk{background:#2C5BB4;color:#fff}
.opens{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.before .opens s{color:#B5483A}
.after .opens b{color:#2C5BB4;font-weight:600}
.what{font-size:13.5px;margin-top:8px}
.note{margin-top:24px;color:#6F6A61;font-size:13px}
@media (max-width:720px){.ba{grid-template-columns:1fr}h1{font-size:25px}.wrap{padding:28px 16px 40px}}
`;

export function renderFixPreview(doc: FixDocument): string {
  const p = doc.problems[0]!;
  const sides = doc.corrections.map((c) => {
    const label = c.label ?? 'Contact link';
    const ctx = (s: string | undefined) => (s ? `<p class="ctx">${esc(s)}</p>` : '');
    return `<div class="ba">
<section class="side before" aria-label="Before"><header><span class="dot"></span>Before · as captured</header><div class="body">
${ctx(c.context?.before)}<span class="lnk">${esc(label)}</span>${ctx(c.context?.after)}
<p class="opens">Opens <s>${esc(c.observedHref)}</s></p></div></section>
<section class="side after" aria-label="After"><header><span class="dot"></span>After · proposed fix</header><div class="body">
${ctx(c.context?.before)}<a class="lnk" href="${esc(c.correctedHref)}" rel="noopener noreferrer">${esc(label)}</a>${ctx(c.context?.after)}
<p class="opens">Opens <b>${esc(c.correctedHref)}</b></p><p class="what">${esc(describeHref(c.correctedHref))}.</p></div></section>
</div>`;
  }).join('');
  const links = doc.corrections.reduce((n, c) => n + c.replaced, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(`Proposed fix for ${doc.business.name}`)}</title>
<style>${embeddedFontFaces(['geist'])}${CSS}</style></head><body><main class="wrap">
<div class="eyebrow">Proposed fix · ${esc(doc.business.name)}</div>
<h1>A fix for a contact link on ${esc(host(doc.page.url))}</h1>
<p class="lede">${esc(p.plainIssue)}. Below is the link as it was on your page, and the same link with the destination corrected.</p>
<section class="card" aria-label="What was observed"><div class="label">What was observed</div>
<div class="quote">${esc(p.quote)}</div>
<div class="meta"><span>${esc(p.url)}</span><span>Observed ${esc(day(p.observedAt))}</span><span>Page captured ${esc(day(doc.page.capturedAt))}</span></div></section>
${sides}
<p class="note">Only the destination of ${links === 1 ? 'this link changes' : `these ${links} links changes`}. Everything else on the page stays exactly as it was captured. This is a preview: nothing on your live website has been changed.</p>
</main></body></html>`;
}
