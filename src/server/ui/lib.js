// Shared helpers for the Scopely app's plain modules (U1: no framework). Every module builds DOM
// with h(), talks to the server with api() and reports with toast().

export const $app = document.getElementById('app');
export const $toasts = document.getElementById('toasts');

// ------------------------------------------------------------------ helpers

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with the constant icon strings below
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(method, path, body, headers) {
  const init = { method, headers: { 'x-scopely-request': '1', ...(headers || {}) } };
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(`/api${path}`, init); } catch { throw new Error('Scopely cannot be reached. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

/** A dark toast at the bottom of the screen, with an optional action (Undo). */
export function toast(msg, opts = {}) {
  const t = h('div', { class: `toast ${opts.bad ? 'bad' : ''}`, role: 'status' }, h('span', { text: msg }),
    opts.action ? h('button', { onclick: () => { t.remove(); opts.action.run(); } }, opts.action.label) : null);
  $toasts.replaceChildren(t); // one at a time, newest wins
  setTimeout(() => t.remove(), opts.action ? 9000 : opts.bad ? 6500 : 3200);
}
export const fail = (err) => toast(err.message, { bad: true });

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const date = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
export const when = (iso) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Today ${time}` : `${date(iso)} ${time}`;
};
export const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
export const confidenceWord = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };
export const claimWord = { OBSERVED: 'Observed', INFERRED: 'Inferred' };
export const money = (currency, price) => {
  if (price === null || price === undefined) return 'Price not set';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(price)); } catch { return `${currency} ${price}`; }
};
export const slugOf = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
export const remember = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch { /* optional */ } return ''; };

export const I = {
  back: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10H4M9 5l-5 5 5 5"/></svg>',
  close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m5 5 10 10M15 5 5 15"/></svg>',
  up: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg>',
  down: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4v12M5 11l5 5 5-5"/></svg>',
  eye: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.5"/></svg>',
  eyeoff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l14 14M8.3 5A8.6 8.6 0 0 1 10 4.5c5.2 0 8.2 5.5 8.2 5.5a14 14 0 0 1-2.4 3M5.4 6.6A13.6 13.6 0 0 0 1.8 10s3 5.5 8.2 5.5c1.3 0 2.5-.3 3.5-.8"/></svg>',
  lock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="9" width="12" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>',
};
export const icon = (name) => h('span', { html: I[name], style: 'display:inline-flex' });

export function go(hash) { location.hash = hash; }
