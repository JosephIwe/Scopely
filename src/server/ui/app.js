// Scopely Build Workspace. Plain modules, no framework. The browser never edits site HTML: every
// change is an edit operation sent to the server, which validates it, applies it to the stored
// site document and returns the rendered preview.

const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

// ------------------------------------------------------------------ helpers

function h(tag, props, ...kids) {
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

async function api(method, path, body, headers) {
  const init = { method, headers: { 'x-scopely-request': '1', ...(headers || {}) } };
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(`/api${path}`, init); } catch { throw new Error('Scopely cannot be reached. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

function toast(msg, tone) {
  const t = h('div', { class: `toast ${tone || ''}`, role: 'status' }, msg);
  $toasts.append(t);
  setTimeout(() => t.remove(), tone === 'bad' ? 6000 : 3200);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const date = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return date(iso);
};
const statusWord = { DRAFT: 'Draft', APPROVED: 'Approved', SHOWN: 'Shown', SUPERSEDED: 'Earlier version', DISCARDED: 'Discarded' };
const confidenceWord = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };
const claimWord = { OBSERVED: 'Seen directly', INFERRED: 'Inferred' };

const I = {
  back: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4 6 10l6 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><path d="M12 8.5 13.2 11 15.5 12l-2.3 1-1.2 2.5-1.2-2.5L8.5 12l2.3-1L12 8.5Z"/></svg>',
  sections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="16" height="5" rx="1.5"/><rect x="4" y="11" width="16" height="4" rx="1.5"/><rect x="4" y="17" width="16" height="3" rx="1.5"/></svg>',
  design: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.7 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3Z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/></svg>',
  versions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
  why: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>',
  tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/></svg>',
  mobile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};
const icon = (name) => h('span', { html: I[name], style: 'display:inline-flex' });

function appbar(...crumbs) {
  return h('header', { class: 'appbar' },
    h('a', { class: 'logo', href: '#/' }, h('i'), 'Scopely'),
    crumbs.length ? h('div', { class: 'crumbs' }, h('span', { text: '/' }), ...crumbs.flatMap((c, i) => i ? [h('span', { text: '/' }), c] : [c])) : null);
}

// ------------------------------------------------------------------ router

let leaveGuard = null;
window.addEventListener('beforeunload', (e) => { if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });

function go(hash) { location.hash = hash; }

async function route() {
  const hsh = location.hash || '#/';
  let m;
  if ((m = hsh.match(/^#\/p\/(\d+)\/setup$/))) return setupView(m[1]);
  if ((m = hsh.match(/^#\/p\/(\d+)$/))) return workspaceView(m[1]);
  leaveGuard = null;
  return opportunitiesView();
}
window.addEventListener('hashchange', () => {
  if (leaveGuard && leaveGuard() && !confirm('You have unsaved changes. Leave without saving?')) return;
  leaveGuard = null;
  route();
});

// ------------------------------------------------------------------ 1-2. opportunities

async function opportunitiesView() {
  const list = h('div', { class: 'opps' }, [1, 2, 3].map(() => h('div', { class: 'card skeleton', style: 'height:92px' })));
  $app.replaceChildren(appbar(), h('main', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', { text: 'Opportunities' }),
      h('p', { class: 'muted', text: 'Businesses where Scopely found a real, fixable problem. Build a website for any opportunity mapped to a website service.' }))),
    list));
  let opps;
  try { opps = await api('GET', '/opportunities'); } catch (err) {
    list.replaceWith(h('div', { class: 'card empty' }, h('h2', { text: 'Opportunities could not be loaded' }), h('p', { class: 'muted', text: err.message }),
      h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => route(), text: 'Try again' }))));
    return;
  }
  if (!opps.length) {
    list.replaceWith(h('div', { class: 'card empty' }, h('h2', { text: 'No opportunities yet' }),
      h('p', { class: 'muted', text: 'When a search finds a business with an observed problem you can sell a fix for, it appears here.' })));
    return;
  }
  list.replaceChildren(...opps.map((o) => {
    const action = o.projectId
      ? h('button', { class: 'btn', onclick: () => go(`#/p/${o.projectId}`) }, 'Open build')
      : o.buildable
        ? h('button', { class: 'btn primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { const r = await api('POST', `/opportunities/${o.opportunityId}/website`); go(`#/p/${r.projectId}/setup`); }
            catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; }
          } }, 'Build')
        : h('span', { class: 'muted small', text: o.service ? 'Not a website service' : 'No service mapped' });
    return h('article', { class: 'card opp' },
      h('div', {},
        h('div', { class: 'row' }, h('h3', { text: o.business }), o.path ? h('span', { class: 'badge', text: o.path === 'WEBSITE' ? 'Website' : 'Fix' }) : null),
        o.issue ? h('p', { class: 'issue', text: o.issue }) : null,
        h('div', { class: 'meta' },
          o.service ? h('span', {}, o.service, o.price ? ` · ${o.currency} ${o.price}` : ' · price not set') : null,
          h('span', { text: '·' }), h('span', { text: plural(o.evidenceCount, 'finding', 'findings') }),
          o.topConfidence ? [h('span', { text: '·' }), h('span', { text: confidenceWord[o.topConfidence] })] : null,
          o.domain ? [h('span', { text: '·' }), h('span', { class: 'mono', text: o.domain })] : null)),
      action);
  }));
}

// ------------------------------------------------------------------ 3-8. build setup and generation

function evidenceCard(e) {
  return h('div', { class: 'evidence' },
    h('div', { class: 'row' }, h('strong', { class: 'grow', text: e.plainIssue }), h('span', { class: 'badge', text: claimWord[e.claimState] })),
    h('div', { class: 'q', text: e.quote }),
    h('div', { class: 'src' }, h('span', { class: 'mono', text: e.url }), h('span', { text: `Seen ${date(e.observedAt)}` }), h('span', { text: confidenceWord[e.confidence] })));
}

function basisLists(basis) {
  return [
    h('div', {}, h('div', { class: 'ba-label', text: 'The site will state' }),
      h('ul', { class: 'list' }, basis.usedFacts.map((f) => h('li', {}, h('span', { class: 'ico', text: '✓' }),
        h('div', {}, h('div', { text: f.attribute[0].toUpperCase() + f.attribute.slice(1) }), h('div', { class: 'muted small', text: `Source: ${f.source.replace(/_/g, ' ')}` })))))),
    basis.notUsed.length ? h('div', {}, h('div', { class: 'ba-label', text: 'Left out on purpose' }),
      h('ul', { class: 'list' }, basis.notUsed.map((n) => h('li', {}, h('span', { class: 'ico no', text: '–' }),
        h('div', {}, h('div', { text: n.what[0].toUpperCase() + n.what.slice(1) }), h('div', { class: 'muted small', text: n.why })))))) : null,
  ];
}

function templateThumb() {
  return h('div', { class: 'thumb', 'aria-hidden': 'true' },
    h('div', { class: 't-nav' }, h('b'), h('i')), h('div', { class: 't-h' }, h('span'), h('span'), h('em')), h('div', { class: 't-v', text: 'A' }));
}

function progress(title, steps) {
  const items = steps.map((s) => h('li', {}, h('i'), s));
  const el = h('div', { class: 'gen', role: 'status' }, h('div', { class: 'card' }, h('h2', { text: title }),
    h('p', { class: 'muted small', style: 'margin-top:4px', text: 'Nothing is published. You review everything before it is shown to anyone.' }), h('ol', {}, items)));
  document.body.append(el);
  let i = 0;
  const mark = () => items.forEach((li, j) => { li.className = j < i ? 'done' : j === i ? 'on' : ''; });
  mark();
  const timer = setInterval(() => { if (i < steps.length - 1) { i++; mark(); } }, 650);
  return {
    async done() { clearInterval(timer); i = steps.length; mark(); await new Promise((r) => setTimeout(r, 350)); el.remove(); },
    fail() { clearInterval(timer); el.remove(); },
  };
}

async function setupView(pid) {
  leaveGuard = null;
  $app.replaceChildren(appbar(h('a', { href: '#/', text: 'Opportunities' })), h('main', { class: 'page' }, h('div', { class: 'boot', style: 'height:50vh' }, h('div', { class: 'spinner' }))));
  let s;
  try { s = await api('GET', `/projects/${pid}/setup`); } catch (err) {
    $app.replaceChildren(appbar(h('a', { href: '#/', text: 'Opportunities' })), h('main', { class: 'page' },
      h('div', { class: 'card empty' }, h('h2', { text: 'This build cannot start yet' }), h('p', { class: 'muted', text: err.message }))));
    return;
  }
  if (s.hasVersions) return go(`#/p/${pid}`);
  let template = s.templates[0]?.key;
  const tplCards = s.templates.map((t) => {
    const card = h('button', { class: `choice ${t.key === template ? 'on' : ''}`, type: 'button', onclick: () => {
      template = t.key; tplCards.forEach((c) => c.classList.toggle('on', c === card)); } },
      h('span', { class: 'tick' }),
      h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' }, templateThumb(),
        h('div', {}, h('h3', { text: t.name }), h('p', { class: 'muted', style: 'margin-top:4px', text: t.description }),
          h('div', { class: 'chips' }, t.sections.map((x) => h('span', { class: 'chip', text: x }))))));
    return card;
  });
  const buildBtn = h('button', { class: 'btn primary lg', style: 'width:100%', onclick: build }, 'Build website');
  const errBox = h('div');

  async function build() {
    buildBtn.disabled = true;
    errBox.replaceChildren();
    const p = progress(`Building ${s.business.name}`, ['Reading the opportunity and its evidence', `Applying the ${s.templates.find((t) => t.key === template).name} template`,
      'Writing only what can be backed up', 'Rendering the preview']);
    try {
      const r = await api('POST', `/projects/${pid}/generate`, { templateKey: template });
      if (r.status !== 'SUCCEEDED') {
        p.fail();
        errBox.replaceChildren(h('div', { class: 'note bad', style: 'margin-top:12px', text: r.message || 'The build did not finish. Nothing was saved; try again.' }));
        buildBtn.disabled = false;
        buildBtn.textContent = 'Try again';
        return;
      }
      await p.done();
      go(`#/p/${pid}`);
    } catch (err) {
      p.fail();
      errBox.replaceChildren(h('div', { class: 'note bad', style: 'margin-top:12px', text: err.message }));
      buildBtn.disabled = false;
    }
  }

  $app.replaceChildren(appbar(h('a', { href: '#/', text: 'Opportunities' }), h('span', { text: s.business.name })), h('main', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: `Build a website for ${s.business.name}` }),
      h('p', { class: 'muted', text: 'Scopely starts from what it found, uses one template, and states only what it can back up. You edit and approve before anyone sees it.' }))),
    h('div', { class: 'setup' },
      h('div', { class: 'stack' },
        h('section', { class: 'card step' },
          h('div', { class: 'step-head' }, h('span', { class: 'n', text: '1' }), h('div', {}, h('h2', { text: 'What Scopely found' }),
            h('p', { class: 'muted small', text: 'The problem behind this opportunity. The site is built to answer it.' }))),
          h('div', { class: 'stack-sm' }, s.basis.problem.map(evidenceCard))),
        h('section', { class: 'card step' },
          h('div', { class: 'step-head' }, h('span', { class: 'n', text: '2' }), h('div', {}, h('h2', { text: 'Build type' }))),
          h('div', { class: 'choice on', role: 'radio', 'aria-checked': 'true' }, h('span', { class: 'tick' }),
            h('div', {}, h('h3', { text: s.buildType.name }), h('p', { class: 'muted', style: 'margin-top:3px', text: s.buildType.description })))),
        h('section', { class: 'card step' },
          h('div', { class: 'step-head' }, h('span', { class: 'n', text: '3' }), h('div', {}, h('h2', { text: 'Template' }),
            h('p', { class: 'muted small', text: 'Colours, type and layout can all be changed after the build.' }))),
          h('div', { class: 'stack-sm', role: 'radiogroup' }, tplCards)),
        h('section', { class: 'card step' },
          h('div', { class: 'step-head' }, h('span', { class: 'n', text: '4' }), h('div', {}, h('h2', { text: 'What the site will do about it' }))),
          h('ul', { class: 'list' }, s.basis.addresses.map((a) => h('li', {}, h('span', { class: 'ico', text: '→' }), h('div', { text: a.change })))))),
      h('aside', { class: 'aside stack' },
        h('div', { class: 'card pad stack' }, h('h2', { text: 'Information the build will use' }), ...basisLists(s.basis)),
        h('div', { class: 'card pad' }, buildBtn, errBox,
          h('p', { class: 'muted small', style: 'margin-top:10px;text-align:center', text: 'Creates a draft. Nothing is published or sent.' }))))));
}

// ------------------------------------------------------------------ 8-15. the workspace

const DEVICE_WIDTH = { desktop: 'desktop', tablet: 'tablet', mobile: 'mobile' };
const SECTION_LETTER = { hero: 'H', services: 'S', about: 'A', proof: 'R', gallery: 'G', contact: 'C', footer: 'F' };
const LINK_STATE = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' };
const CTA_KINDS = [['unset', 'Not set yet'], ['phone', 'Phone call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['link', 'Web link']];
const CTA_PLACEHOLDER = { phone: '+44 20 7946 0000', whatsapp: '447700900123 (with country code)', email: 'enquiries@business.example', link: 'https://…' };

async function workspaceView(pid) {
  const S = { pid, view: null, ops: [], draft: null, selected: 'hero', tab: 'edit', device: 'desktop', seq: 0, busy: false, aiResult: null, share: null };
  leaveGuard = () => S.ops.length > 0;
  $app.replaceChildren(h('div', { class: 'boot' }, h('div', { class: 'spinner' })));

  async function load(selected) {
    const v = await api('GET', `/projects/${pid}/workspace${selected ? `?selected=${selected}` : ''}`);
    S.view = v; S.ops = []; S.draft = null;
    return v;
  }
  try { await load(S.selected); } catch (err) {
    $app.replaceChildren(appbar(h('a', { href: '#/', text: 'Opportunities' })), h('main', { class: 'page' },
      h('div', { class: 'card empty' }, h('h2', { text: 'This build could not be opened' }), h('p', { class: 'muted', text: err.message }),
        h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => route(), text: 'Try again' })))));
    return;
  }
  if (!S.view.current) return go(`#/p/${pid}/setup`);

  const doc = () => (S.draft ? S.draft.document : S.view.current.document);
  const readiness = () => (S.draft ? S.draft.readiness : S.view.current.readiness);
  const tpl = S.view.template;
  const spec = (type) => tpl.sections.find((x) => x.type === type);
  const section = (type) => doc().sections.find((x) => x.type === type);

  // ---------------------------------------------------------------- layout
  const $top = h('header', { class: 'ws-top' });
  const $rail = h('nav', { class: 'rail', 'aria-label': 'Workspace' });
  const $panel = h('aside', { class: 'panel' });
  const $ready = h('div');
  const $iframe = h('iframe', { title: 'Live preview', sandbox: 'allow-same-origin' });
  const $frame = h('div', { class: `frame ${S.device}` }, $iframe);
  const $busy = h('div', { class: 'busy-veil', hidden: true }, h('div', { class: 'spinner' }), 'Updating preview');
  const $stage = h('section', { class: 'stage', 'aria-label': 'Preview' }, $ready, h('div', { class: 'frame-wrap' }, $frame, $busy));
  $app.replaceChildren(h('div', { class: 'ws' }, $top, $rail, $panel, $stage));

  // ---------------------------------------------------------------- preview
  let lastHtml = '';
  let keepScroll = true;
  function showPreview(html) {
    if (html === lastHtml) return;
    const y = keepScroll ? ($iframe.contentWindow?.scrollY ?? 0) : null;
    lastHtml = html;
    $iframe.srcdoc = html;
    $iframe.onload = () => {
      const d = $iframe.contentDocument;
      if (!d) return;
      // The parent attaches the listeners; the preview itself runs no script.
      d.querySelectorAll('[data-section]').forEach((el) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => { e.preventDefault(); select(el.getAttribute('data-section'), false); }, true);
      });
      d.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
      if (y !== null) $iframe.contentWindow.scrollTo(0, y);
      else d.querySelector('[data-selected]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      keepScroll = true;
    };
  }

  let timer = null;
  function refresh(delay = 160) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const seq = ++S.seq;
      $busy.hidden = false;
      try {
        const r = await api('POST', `/projects/${pid}/render`, { baseBuildId: S.view.current.buildId, operations: opsForServer(), selected: S.selected });
        if (seq !== S.seq) return;
        S.draft = r;
        showPreview(r.html);
        drawReady(); drawTop();
      } catch (err) {
        if (seq !== S.seq) return;
        // The last edit was refused: drop it and say why.
        S.ops.pop();
        toast(err.message, 'bad');
        drawPanel(); drawTop();
        if (S.ops.length) refresh(0); else { S.draft = null; showPreview(S.view.current.html); drawReady(); }
      } finally {
        if (seq === S.seq) $busy.hidden = true;
      }
    }, delay);
  }

  /** Adds an edit. Edits to the same field in a row merge, so undo steps back one field at a time. */
  function edit(op, key) {
    const last = S.ops[S.ops.length - 1];
    if (key && last && last.__key === key) S.ops[S.ops.length - 1] = { ...op, __key: key };
    else S.ops.push(key ? { ...op, __key: key } : op);
    drawTop();
    refresh();
  }
  const opsForServer = () => S.ops.map(({ __key, ...op }) => op);

  function select(type, scroll = true) {
    S.selected = type;
    if (S.tab !== 'edit') S.tab = 'edit';
    keepScroll = !scroll;
    drawRail(); drawPanel();
    refresh(0);
  }

  // ---------------------------------------------------------------- top bar
  function drawTop() {
    const cur = S.view.current;
    const status = cur.status;
    const pending = S.ops.length;
    const devices = h('div', { class: 'seg', role: 'group', 'aria-label': 'Preview size' },
      ['desktop', 'tablet', 'mobile'].map((d) => h('button', { class: S.device === d ? 'on' : '', title: d[0].toUpperCase() + d.slice(1), 'aria-pressed': String(S.device === d),
        onclick: () => { S.device = d; $frame.className = `frame ${DEVICE_WIDTH[d]}`; drawTop(); } }, icon(d))));
    $top.replaceChildren(...[
      h('a', { class: 'btn ghost icon', href: '#/', title: 'Opportunities', 'aria-label': 'Back to opportunities' }, icon('back')),
      h('div', { class: 'title' }, h('h1', { text: S.view.project.title }),
        h('span', { class: `badge dot ${status.toLowerCase()}` }, `Version ${cur.versionNo} · ${statusWord[status]}`),
        pending ? h('span', { class: 'unsaved', text: `${plural(pending, 'unsaved change', 'unsaved changes')}` }) : null),
      h('div', { class: 'grow' }),
      devices,
      h('div', { class: 'sep' }),
      h('button', { class: 'btn ghost icon', title: 'Undo', 'aria-label': 'Undo', disabled: !pending, onclick: undo }, icon('undo')),
      h('button', { class: 'btn', disabled: !pending || S.busy, onclick: save }, 'Save version'),
      h('button', { class: 'btn ghost', title: 'Open the saved version in a new tab', disabled: S.busy, onclick: openPreview }, icon('open'), 'Preview'),
      status === 'DRAFT' ? h('button', { class: 'btn primary', disabled: S.busy, onclick: () => { S.tab = 'versions'; drawRail(); drawPanel(); } }, 'Approve…') : null,
      status === 'APPROVED' ? h('button', { class: 'btn good', disabled: S.busy, onclick: () => { S.tab = 'versions'; drawRail(); drawPanel(); } }, 'Show…') : null,
      status === 'SHOWN' ? h('button', { class: 'btn', disabled: S.busy, onclick: () => { S.tab = 'versions'; drawRail(); drawPanel(); } }, 'Share link') : null].filter(Boolean));
  }

  function undo() {
    if (!S.ops.length) return;
    S.ops.pop();
    drawPanel(); drawTop();
    if (S.ops.length) refresh(0);
    else { S.seq++; S.draft = null; showPreview(S.view.current.html); drawReady(); $busy.hidden = true; }
  }

  async function reload(msg) {
    await load(S.selected);
    lastHtml = '';
    showPreview(S.view.current.html);
    drawTop(); drawRail(); drawPanel(); drawReady();
    if (msg) toast(msg, 'good');
  }

  async function save() {
    if (!S.ops.length) return;
    S.busy = true; drawTop();
    try {
      await api('POST', `/projects/${pid}/save`, { baseBuildId: S.view.current.buildId, operations: opsForServer() });
      await reload();
      toast(`Saved as version ${S.view.current.versionNo}`, 'good');
    } catch (err) { toast(err.message, 'bad'); } finally { S.busy = false; drawTop(); }
  }

  async function openPreview() {
    const win = window.open('', '_blank', 'noopener');
    try {
      const r = await api('POST', `/projects/${pid}/versions/${S.view.current.buildId}/link`, { kind: 'edit' });
      if (win) win.location = r.url; else location.href = r.url;
      if (S.ops.length) toast('The preview shows the last saved version. Save to include your changes.');
    } catch (err) { win?.close(); toast(err.message, 'bad'); }
  }

  // ---------------------------------------------------------------- readiness bar
  function drawReady() {
    const items = readiness();
    const cur = S.view.current;
    if (!items.length) {
      $ready.replaceChildren(h('div', { class: 'readybar ok' }, cur.status === 'SHOWN' ? `Version ${cur.versionNo} has been shown.` : 'Nothing is missing. Save, then approve when you are happy with it.'));
      return;
    }
    $ready.replaceChildren(h('div', { class: 'readybar' }, h('strong', { text: plural(items.length, 'thing needs you', 'things need you') }),
      h('span', { class: 'grow', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: items[0].message }),
      h('button', { class: 'btn sm', onclick: () => fixReady(items[0]) }, 'Fix')));
  }
  function fixReady(item) {
    if (item.section === 'cta') return select('hero');
    select(item.section);
  }

  // ---------------------------------------------------------------- rail
  const TABS = [['edit', 'Edit'], ['ai', 'AI'], ['sections', 'Sections'], ['design', 'Design'], ['versions', 'Versions'], ['why', 'Why']];
  function drawRail() {
    $rail.replaceChildren(...TABS.map(([k, label]) => h('button', { class: `tab ${S.tab === k ? 'on' : ''}`, 'aria-current': S.tab === k ? 'page' : null,
      onclick: () => { S.tab = k; drawRail(); drawPanel(); } }, icon(k === 'ai' ? 'ai' : k), label)));
  }

  function panelHead(title, sub) {
    return h('div', { class: 'panel-head' }, h('h2', { text: title }), sub ? h('p', { class: 'muted small', text: sub }) : null);
  }

  function drawPanel() {
    const sc = $panel.scrollTop;
    const body = { edit: editTab, ai: aiTab, sections: sectionsTab, design: designTab, versions: versionsTab, why: whyTab }[S.tab]();
    $panel.replaceChildren(...body.flat(Infinity).filter(Boolean));
    $panel.scrollTop = sc;
  }

  // ---------------------------------------------------------------- Edit
  function textField(sec, slot, sp) {
    const val = String(section(sec).content[slot] ?? '');
    const count = h('em', { text: `${val.length}/${sp.maxLength}` });
    const attrs = { value: val, maxlength: sp.maxLength, placeholder: sp.placeholder,
      oninput: (e) => { count.textContent = `${e.target.value.length}/${sp.maxLength}`; edit({ op: 'update_text', section: sec, slot, value: e.target.value }, `t:${sec}.${slot}`); } };
    const input = sp.multiline ? h('textarea', { ...attrs, value: null, rows: slot === 'body' ? 6 : 3 }, val) : h('input', { type: 'text', ...attrs });
    return h('label', { class: 'field' }, h('span', { class: 'lab' }, sp.label, count), input);
  }

  function itemsField(sec, slot, sp) {
    const items = () => (section(sec).content[slot] || []).map((x) => ({ ...x }));
    const commit = (list) => edit({ op: 'update_items', section: sec, slot, items: list }, `i:${sec}.${slot}`);
    const [ft, fx] = sp.fields;
    const rows = items().map((it, i) => h('div', { class: 'item' },
      h('div', { class: 'row' }, h('input', { type: 'text', value: it.title, maxlength: ft.maxLength, placeholder: ft.label, 'aria-label': ft.label,
        oninput: (e) => { const l = items(); l[i].title = e.target.value; commit(l); } }),
        h('button', { class: 'btn ghost sm', title: 'Remove', 'aria-label': `Remove ${it.title || 'entry'}`, onclick: () => { const l = items(); l.splice(i, 1); commit(l); drawPanel(); } }, '✕')),
      h('input', { type: 'text', value: it.text, maxlength: fx.maxLength, placeholder: `${fx.label} (optional)`, 'aria-label': fx.label,
        oninput: (e) => { const l = items(); l[i].text = e.target.value; commit(l); } })));
    const full = items().length >= sp.max;
    return h('div', {}, h('div', { class: 'lab row', style: 'justify-content:space-between;font-size:12.5px;font-weight:550;margin-bottom:6px' },
      h('span', { text: sp.label }), h('em', { class: 'muted', style: 'font-style:normal', text: `${items().length}/${sp.max}` })),
      h('div', { class: 'items' }, rows,
        h('button', { class: 'btn sm', disabled: full, onclick: (e) => addItemRow(e.currentTarget, sec, slot, sp) },
          full ? `Up to ${sp.max}` : `+ Add ${ft.label.toLowerCase()}`)));
  }
  // A new entry lives only in the form until it has a title, because an empty title is not a valid edit.
  function addItemRow(button, sec, slot, sp) {
    const [ft, fx] = sp.fields;
    const title = h('input', { type: 'text', maxlength: ft.maxLength, placeholder: ft.label, 'aria-label': ft.label });
    const text = h('input', { type: 'text', maxlength: fx.maxLength, placeholder: `${fx.label} (optional)`, 'aria-label': fx.label });
    const row = h('div', { class: 'item' }, title, text);
    let index = null;
    const commitNew = () => {
      if (!title.value.trim()) return;
      const l = (section(sec).content[slot] || []).map((x) => ({ ...x }));
      if (index === null) index = l.length;
      l[index] = { title: title.value, text: text.value };
      edit({ op: 'update_items', section: sec, slot, items: l }, `i:${sec}.${slot}`);
    };
    title.addEventListener('input', commitNew);
    text.addEventListener('input', commitNew);
    row.addEventListener('focusout', (e) => { if (index !== null && !row.contains(e.relatedTarget)) drawPanel(); });
    button.before(row);
    button.disabled = true;
    title.focus();
  }

  function imagePicker(onPick, chosen, multi) {
    const imgs = S.view.images;
    const upload = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'sr', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const description = prompt('Describe this photo in a few words. It becomes the alt text people with screen readers hear.', f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
      if (!description) return;
      try {
        if (S.ops.length) toast('Saving your changes first…');
        if (S.ops.length) await save();
        const r = await api('POST', `/projects/${pid}/images`, f, { 'content-type': 'application/octet-stream', 'x-description': encodeURIComponent(description) });
        await reload('Photo added');
        onPick(r.assetId);
      } catch (err) { toast(err.message, 'bad'); }
    } });
    return h('div', { class: 'imgs' },
      imgs.map((im) => {
        const idx = multi ? chosen.indexOf(im.assetId) : (chosen === im.assetId ? 0 : -1);
        return h('button', { class: `img ${idx >= 0 ? 'on' : ''}`, title: im.description, onclick: () => onPick(im.assetId) },
          h('img', { src: im.dataUrl, alt: im.description }), multi && idx >= 0 ? h('span', { class: 'n', text: String(idx + 1) }) : null);
      }),
      h('label', { class: 'img add' }, upload, '+ Upload'));
  }

  function imageField(sec, slot, sp) {
    const cur = section(sec).content[slot];
    const im = S.view.images.find((x) => x.assetId === cur);
    return h('div', {}, h('div', { class: 'lab', style: 'font-size:12.5px;font-weight:550;margin-bottom:6px', text: sp.label }),
      im ? h('div', { class: 'current-img', style: 'margin-bottom:10px' }, h('div', { class: 'img' }, h('img', { src: im.dataUrl, alt: im.description })),
        h('div', { class: 'grow' }, h('div', { class: 'small', text: im.description }),
          h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: () => { edit({ op: 'replace_image', section: sec, slot, assetId: null }); drawPanel(); } }, 'Remove'))) : null,
      imagePicker((id) => { edit({ op: 'replace_image', section: sec, slot, assetId: id }); drawPanel(); }, cur, false),
      h('p', { class: 'hint', text: 'Only real photos you or the business supplied. Scopely never uses stock images as if they were theirs.' }));
  }

  function galleryField(sec, slot, sp) {
    const cur = [...(section(sec).content[slot] || [])];
    return h('div', {}, h('div', { class: 'lab', style: 'font-size:12.5px;font-weight:550;margin-bottom:6px' }, `${sp.label} · ${cur.length}/${sp.max}`),
      imagePicker((id) => {
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        edit({ op: 'set_images', section: sec, slot, assetIds: next }); drawPanel();
      }, cur, true),
      h('p', { class: 'hint', text: 'Tap photos in the order they should appear. Tap again to remove.' }));
  }

  function ctaGroup() {
    const cta = doc().cta;
    const kind = cta.action.kind;
    let pendingKind = kind;
    const value = h('input', { type: 'text', value: cta.action.value || '', placeholder: CTA_PLACEHOLDER[kind] || '', disabled: kind === 'unset' });
    const kindSel = h('select', { 'aria-label': 'Button destination', onchange: (e) => {
      pendingKind = e.target.value;
      value.disabled = pendingKind === 'unset';
      value.placeholder = CTA_PLACEHOLDER[pendingKind] || '';
      if (pendingKind === 'unset') { value.value = ''; edit({ op: 'update_cta', action: { kind: 'unset' } }, 'cta-action'); }
      else { value.value = ''; value.focus(); }
    } }, CTA_KINDS.map(([k, l]) => h('option', { value: k, selected: k === kind }, l)));
    value.addEventListener('change', () => { if (value.value.trim()) edit({ op: 'update_cta', action: { kind: pendingKind, value: value.value } }, 'cta-action'); });
    return h('div', { class: 'group' }, h('h3', {}, 'Main button', kind === 'unset' ? h('span', { class: 'badge warn', text: 'No destination' }) : null),
      h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Label', h('em', { text: `${cta.label.length}/32` })),
          h('input', { type: 'text', value: cta.label, maxlength: 32, oninput: (e) => edit({ op: 'update_cta', label: e.target.value }, 'cta-label') })),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Where it goes'), kindSel),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Number, address or link'), value,
          h('p', { class: 'hint', text: 'Use details the business really uses. The button appears in the header, the hero, the contact section and a bar on phones.' }))));
  }

  function editTab() {
    const visible = doc().sections;
    const nav = h('div', { class: 'sections-nav' }, visible.map((s) => h('button', { class: `${S.selected === s.type ? 'on' : ''} ${s.visible ? '' : 'off'}`,
      onclick: () => select(s.type) }, h('span', { class: 'k', text: SECTION_LETTER[s.type] }), h('span', { class: 'grow', text: spec(s.type).name }),
      s.visible ? null : h('span', { class: 'small muted', text: 'Hidden' }))));
    const sp = spec(S.selected);
    const sec = section(S.selected);
    const fields = [];
    if (!sec.visible) fields.push(h('div', { class: 'note info' }, `${sp.name} is hidden. `, sp.hideable && !(sp.factBound && !doc().facts.reviews)
      ? h('button', { class: 'btn sm', style: 'margin-left:6px', onclick: () => { edit({ op: 'show_section', section: S.selected }); drawPanel(); } }, 'Show it') : null));
    if (sp.factBound === 'reviews') {
      const r = doc().facts.reviews;
      fields.push(h('div', { class: `note ${r ? 'good' : 'warn'}`, text: r
        ? `Shows ${r.rating ?? ''}${r.rating ? ' out of 5' : ''}${r.count !== null ? ` from ${r.count} reviews` : ''} as reported by ${r.source.replace(/_/g, ' ')}${r.asOf ? ` on ${date(r.asOf)}` : ''}. Ratings come only from a named source and cannot be typed in.`
        : 'There is no sourced review data for this business, so this section stays hidden. Ratings and reviews are never written by hand or by AI.' }));
    }
    for (const [slot, s] of Object.entries(sp.slots)) {
      if (s.kind === 'text') fields.push(textField(S.selected, slot, s));
      else if (s.kind === 'items') fields.push(itemsField(S.selected, slot, s));
      else if (s.kind === 'image') fields.push(imageField(S.selected, slot, s));
      else if (s.kind === 'images') fields.push(galleryField(S.selected, slot, s));
    }
    return [panelHead('Edit', 'Choose a section, or click it in the preview.'),
      h('div', { class: 'panel-body' }, nav,
        h('div', { class: 'group' }, h('h3', {}, sp.name, h('span', { class: 'muted small', style: 'font-weight:450', text: '' })),
          h('p', { class: 'muted small', style: 'margin:-4px 0 12px', text: sp.purpose }), h('div', { class: 'stack' }, fields)),
        S.selected === 'hero' || S.selected === 'contact' ? ctaGroup() : null)];
  }

  // ---------------------------------------------------------------- Sections
  function sectionsTab() {
    const secs = doc().sections;
    return [panelHead('Sections', 'Show, hide and reorder. The hero stays first and the footer last.'),
      h('div', { class: 'panel-body' }, secs.map((s, i) => {
        const sp = spec(s.type);
        const noData = sp.factBound === 'reviews' && !doc().facts.reviews;
        const canToggle = sp.hideable && !(noData && !s.visible);
        const prev = secs[i - 1]; const next = secs[i + 1];
        return h('div', { class: 'sec-row' },
          h('button', { class: `toggle ${s.visible ? 'on' : ''}`, role: 'switch', 'aria-checked': String(s.visible), 'aria-label': `Show ${sp.name}`, disabled: !canToggle,
            title: !sp.hideable ? 'Always shown' : noData ? 'No sourced review data' : '',
            onclick: () => { edit({ op: s.visible ? 'hide_section' : 'show_section', section: s.type }); drawPanel(); } }),
          h('div', { class: 'grow' }, h('div', { style: 'font-weight:600', text: sp.name }),
            h('div', { class: 'muted small', text: noData ? 'Hidden: no sourced review data' : sp.purpose })),
          h('button', { class: 'btn ghost sm icon', title: 'Move up', 'aria-label': `Move ${sp.name} up`, disabled: !sp.movable || !prev || !spec(prev.type).movable,
            onclick: () => { edit({ op: 'move_section', section: s.type, direction: 'up' }); drawPanel(); } }, '↑'),
          h('button', { class: 'btn ghost sm icon', title: 'Move down', 'aria-label': `Move ${sp.name} down`, disabled: !sp.movable || !next || !spec(next.type).movable,
            onclick: () => { edit({ op: 'move_section', section: s.type, direction: 'down' }); drawPanel(); } }, '↓'));
      }))];
  }

  // ---------------------------------------------------------------- Design
  function designTab() {
    const th = doc().theme;
    const hero = section('hero');
    const layoutMini = {
      split: [['8%', '30%', '38%', '10%'], ['8%', '48%', '26%', '7%'], ['56%', '18%', '36%', '64%']],
      centered: [['30%', '18%', '40%', '10%'], ['36%', '36%', '28%', '7%'], ['12%', '58%', '76%', '30%']],
      banner: [['0', '0', '100%', '100%', '#48505c'], ['12%', '34%', '50%', '12%', '#f2efe9'], ['12%', '58%', '30%', '8%', '#f2efe9']],
    };
    return [panelHead('Design', 'Colours, type and layout from the template. Every choice stays readable on phones.'),
      h('div', { class: 'panel-body' },
        h('div', { class: 'group' }, h('h3', { text: 'Colour scheme' }),
          h('div', { class: 'swatches' }, tpl.palettes.map((p) => h('button', { class: `swatch ${th.palette === p.key ? 'on' : ''}`,
            onclick: () => { edit({ op: 'change_color', palette: p.key }); drawPanel(); } },
            h('div', { class: 'bar' }, h('span', { style: `background:${p.bg}` }), h('span', { style: `background:${p.ink}` }), h('span', { style: `background:${p.accent}` })),
            h('span', { class: 'small', style: 'font-weight:600', text: p.name })))),
          h('div', { class: 'row', style: 'margin-top:12px' },
            h('label', { class: 'row grow small', style: 'font-weight:550' }, 'Accent colour',
              h('input', { type: 'color', value: th.accent || tpl.palettes.find((p) => p.key === th.palette).accent, style: 'width:40px;height:28px;border:0;background:none;padding:0',
                onchange: (e) => { edit({ op: 'change_color', accent: e.target.value }, 'accent'); drawPanel(); } })),
            th.accent ? h('button', { class: 'btn sm', onclick: () => { edit({ op: 'change_color', accent: null }); drawPanel(); } }, 'Use scheme colour') : null)),
        h('div', { class: 'group' }, h('h3', { text: 'Type' }),
          h('div', { class: 'fonts' }, tpl.fonts.map((f) => h('button', { class: `font ${th.fonts === f.key ? 'on' : ''}`,
            onclick: () => { edit({ op: 'change_font', fonts: f.key }); drawPanel(); } },
            h('b', { style: `font-family:${f.heading};font-weight:${f.headingWeight}`, text: 'Aa' }), h('span', { class: 'small', text: f.name }))))),
        h('div', { class: 'group' }, h('h3', { text: 'Hero layout' }),
          h('div', { class: 'layouts' }, spec('hero').variants.map((v) => h('button', { class: `layout ${hero.variant === v.key ? 'on' : ''}`,
            onclick: () => { edit({ op: 'change_layout', section: 'hero', variant: v.key }); drawPanel(); } },
            h('div', { class: 'mini' }, layoutMini[v.key].map(([l, t, w, hh, c]) => h('i', { style: `left:${l};top:${t};width:${w};height:${hh}${c ? `;background:${c}` : ''}` }))),
            v.name)))))];
  }

  // ---------------------------------------------------------------- AI
  const SUGGEST = ['Make the hero feel more premium', 'Change the button to WhatsApp', 'Make it warmer and friendlier', 'Hide the gallery', 'Make the hero a bold banner', 'Use a classic serif'];
  function aiTab() {
    const box = h('textarea', { maxlength: 500, placeholder: 'For example: make the hero feel more premium and change the CTA to WhatsApp', 'aria-label': 'Describe a change' });
    const go_ = h('button', { class: 'btn primary', onclick: run }, 'Apply to a new version');
    async function run() {
      const request = box.value.trim();
      if (!request) { box.focus(); return; }
      go_.disabled = true; S.busy = true; drawTop();
      let p;
      try {
        if (S.ops.length) { toast('Saving your changes first'); await save(); }
        p = progress('Applying your edit', ['Reading your request', 'Turning it into specific edits', 'Checking each edit against the rules', 'Rendering a new version']);
        const r = await api('POST', `/projects/${pid}/ai-edit`, { baseBuildId: S.view.current.buildId, request });
        await p.done();
        if (r.status !== 'SUCCEEDED') { S.aiResult = { ok: false, message: r.message }; drawPanel(); return; }
        await reload();
        S.aiResult = { ok: true };
        drawPanel();
      } catch (err) { p?.fail(); toast(err.message, 'bad'); } finally { go_.disabled = false; S.busy = false; drawTop(); }
    }
    const last = S.view.current.document.lastEdit;
    let result = null;
    if (S.aiResult && !S.aiResult.ok) result = h('div', { class: 'note bad', text: S.aiResult.message });
    else if (last.by === 'ai') {
      result = h('div', { class: 'result' },
        h('h3', { text: `Version ${S.view.current.versionNo}: what changed` }),
        h('p', { class: 'muted small', style: 'margin-bottom:8px' }, '“', last.request, '”'),
        h('ul', { class: 'list' }, last.applied.map((a) => h('li', {}, h('span', { class: 'ico', text: '✓' }), a))),
        last.needsInput.length ? h('div', { class: 'stack-sm', style: 'margin-top:10px' }, last.needsInput.map((q) => h('div', { class: 'note warn' }, q,
          h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: () => select('hero') }, 'Add it now'))))) : null,
        h('p', { class: 'hint', text: 'Not right? Open Versions to restore the previous one.' }));
    }
    return [panelHead('AI edit', 'Describe a change in your own words. Scopely turns it into specific edits and makes a new version you can undo.'),
      h('div', { class: 'panel-body stack' },
        h('div', { class: 'ai-box' }, box, h('div', { class: 'suggest' }, SUGGEST.map((s) => h('button', { onclick: () => { box.value = s; box.focus(); } }, s)))),
        h('div', { class: 'row' }, go_, S.ops.length ? h('span', { class: 'muted small', text: 'Your unsaved changes are saved first.' }) : null),
        result,
        h('div', { class: 'note info', text: 'AI edits change design, layout, sections and copy. Copy is checked like everything Scopely writes: no invented prices, reviews, credentials, locations, history, guarantees, services or contact details. If one is needed, you are asked for it.' }))];
  }

  // ---------------------------------------------------------------- Versions, approval and showing
  function versionsTab() {
    const cur = S.view.current;
    const items = readiness();
    const pending = S.ops.length;
    const approver = (() => { try { return localStorage.getItem('scopely.approver') || ''; } catch { return ''; } })();
    let gate;
    if (cur.status === 'DRAFT') {
      const name = h('input', { type: 'text', value: approver, placeholder: 'Your name', maxlength: 120, 'aria-label': 'Approving as' });
      gate = h('div', { class: 'stack' },
        h('p', { text: `Approve version ${cur.versionNo} when it is ready. Approval is yours alone; Scopely's agents cannot approve.` }),
        items.length ? h('div', { class: 'note warn' }, h('strong', { text: plural(items.length, 'thing is', 'things are') + ' still missing. ' }), 'You can approve anyway; what is missing is left off the site.') : null,
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Approving as'), name),
        h('button', { class: 'btn primary', disabled: pending > 0 || S.busy, onclick: async () => {
          if (!name.value.trim()) { name.focus(); return; }
          try { localStorage.setItem('scopely.approver', name.value.trim()); } catch { /* optional */ }
          try { await api('POST', `/projects/${pid}/versions/${cur.buildId}/approve`, { approvedBy: name.value.trim() }); await reload(`Version ${cur.versionNo} approved`); }
          catch (err) { toast(err.message, 'bad'); }
        } }, pending ? 'Save your changes first' : `Approve version ${cur.versionNo}`),
        cur.approveBlocker ? h('div', { class: 'note bad', text: cur.approveBlocker }) : null);
    } else if (cur.status === 'APPROVED') {
      gate = h('div', { class: 'stack' },
        h('p', { text: `Version ${cur.versionNo} is approved. Showing it records that the prospect saw it and gives you a private link to send. It is a preview, not a live website.` }),
        cur.showBlocker ? h('div', { class: 'note warn' }, cur.showBlocker,
          cur.document.cta.action.kind === 'unset' ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: () => select('hero') }, 'Add the destination')) : null) : null,
        h('button', { class: 'btn good', disabled: Boolean(cur.showBlocker) || pending > 0 || S.busy, onclick: async () => {
          try { await api('POST', `/projects/${pid}/versions/${cur.buildId}/show`); await reload(`Version ${cur.versionNo} marked shown`); }
          catch (err) { toast(err.message, 'bad'); }
        } }, 'Show to prospect'),
        h('p', { class: 'hint', text: 'Editing after approval makes a new version; this one stays exactly as approved.' }));
    } else {
      const who = () => { try { return localStorage.getItem('scopely.approver') || ''; } catch { return ''; } };
      const links = S.view.links.filter((l) => l.versionNo === cur.versionNo);
      const linkRow = (l) => h('div', { class: 'link-row' },
        h('div', { class: 'row' }, h('span', { class: `badge ${l.state.toLowerCase()}`, text: LINK_STATE[l.state] }),
          h('span', { class: 'muted small grow', text: l.state === 'REVOKED' ? `Revoked ${date(l.revokedAt)} by ${l.revokedBy}` : `${l.state === 'ACTIVE' ? 'Works until' : 'Ended'} ${date(l.expiresAt)}` }),
          l.state === 'ACTIVE' ? h('button', { class: 'btn sm danger', onclick: async () => {
            if (!confirm('Revoke this link? Anyone who has it will no longer be able to open the preview. The version itself does not change.')) return;
            try { await api('POST', `/projects/${pid}/links/${l.linkId}/revoke`, { revokedBy: who() || 'seller' }); await reload('Link revoked'); }
            catch (err) { toast(err.message, 'bad'); }
          } }, 'Revoke') : null),
        l.url ? h('div', { class: 'share-link' }, h('input', { type: 'text', readonly: true, value: new URL(l.url, location.href).href, 'aria-label': 'Prospect link', onfocus: (e) => e.target.select() }),
          h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(new URL(l.url, location.href).href); toast('Link copied'); } catch { toast('Select the link and copy it'); } } }, 'Copy')) : null);
      gate = h('div', { class: 'stack' },
        h('p', { text: `Version ${cur.versionNo} was shown on ${date(S.view.versions.find((v) => v.buildId === cur.buildId)?.shownAt)}. It can no longer change; edits make a new version.` }),
        h('div', { class: 'stack-sm' }, links.length ? links.map(linkRow) : h('p', { class: 'muted small', text: 'No prospect links yet.' })),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => { try { await api('POST', `/projects/${pid}/versions/${cur.buildId}/link`, { kind: 'show' }); await reload('New link ready'); } catch (err) { toast(err.message, 'bad'); } } }, 'New prospect link')),
        h('p', { class: 'hint', text: 'Private links. Each one works for 72 hours unless you revoke it sooner. Nothing is published.' }));
    }
    return [panelHead('Versions', 'Every save and AI edit is a new version. Approved and shown versions never change.'),
      h('div', { class: 'panel-body' },
        h('div', { class: 'group' }, h('h3', {}, cur.status === 'DRAFT' ? 'Approve' : cur.status === 'APPROVED' ? 'Show' : 'Shown',
          h('span', { class: `badge dot ${cur.status.toLowerCase()}`, text: statusWord[cur.status] })), gate),
        items.length ? h('div', { class: 'group' }, h('h3', { text: 'Still missing' }),
          h('ul', { class: 'list ready' }, items.map((it) => h('li', { onclick: () => fixReady(it) }, h('span', { class: 'ico no', text: '○' }), it.message)))) : null,
        h('div', { class: 'group' }, h('h3', { text: 'History' }),
          h('div', { class: 'versions' }, S.view.versions.map((v) => h('div', { class: `ver ${v.buildId === cur.buildId ? 'cur' : ''}` },
            h('div', { class: 'row' }, h('strong', { text: `Version ${v.versionNo}` }), h('span', { class: `badge ${v.status.toLowerCase()}`, text: statusWord[v.status] }),
              h('span', { class: 'grow' }), h('span', { class: 'muted small', text: `${v.madeBy} · ${ago(v.createdAt)}` })),
            h('div', { class: 'sum', text: v.summary }),
            v.approvedBy ? h('div', { class: 'muted small', style: 'margin-top:4px', text: `Approved by ${v.approvedBy} on ${date(v.approvedAt)}` }) : null,
            v.buildId !== cur.buildId ? h('div', { class: 'acts' },
              h('button', { class: 'btn sm', disabled: pending > 0 || S.busy, onclick: async () => {
                try { await api('POST', `/projects/${pid}/restore`, { baseBuildId: cur.buildId, fromBuildId: v.buildId }); await reload(`Version ${v.versionNo} restored as a new version`); }
                catch (err) { toast(err.message, 'bad'); }
              } }, 'Restore')) : null)))))];
  }

  // ---------------------------------------------------------------- Why: before and after
  function whyTab() {
    const b = doc().basis;
    const o = S.view.opportunity;
    return [panelHead('Why this build', 'What Scopely found, and what this site does about it.'),
      h('div', { class: 'panel-body before-after' },
        h('div', {}, h('div', { class: 'ba-label', text: 'Before: what Scopely found' }), h('div', { class: 'stack-sm' }, b.problem.map(evidenceCard))),
        h('div', { class: 'ba-arrow', text: '↓' }),
        h('div', {}, h('div', { class: 'ba-label', text: `After: version ${S.view.current.versionNo}` }),
          h('ul', { class: 'list' }, b.addresses.map((a) => h('li', {}, h('span', { class: 'ico', text: '→' }), a.change)))),
        h('div', { class: 'card pad stack-sm', style: 'background:#fcfcfa' },
          h('div', { class: 'ba-label', text: 'The opportunity' }),
          h('div', { text: o.business }),
          h('div', { class: 'muted small', text: `${o.service || 'Service'} · ${o.price ? `${o.currency} ${o.price}` : 'price not set'}` })),
        ...basisLists(b))];
  }

  // ---------------------------------------------------------------- keyboard
  const onKey = (e) => {
    if (!document.body.contains($panel)) { window.removeEventListener('keydown', onKey); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (mod && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); undo(); }
  };
  window.addEventListener('keydown', onKey);

  drawTop(); drawRail(); drawPanel(); drawReady();
  showPreview(S.view.current.html);
}

route();
