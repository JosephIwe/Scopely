// Scopely Build Workspace. Plain modules, no framework. The browser never edits site HTML: every
// change is an edit operation sent to the server, which validates it, applies it to the stored
// site document and returns the rendered preview. Saving makes a new version; nothing autosaves.

import {
  $app, I, api, cap, claimWord, confidenceWord, date, fail, go, h, icon, money, plural, remember, slugOf, toast, when,
} from './lib.js';
import { shellView } from './shell.js';

function appbar(back) {
  return h('header', { class: 'appbar' },
    h('a', { class: 'logo', href: '#/' }, h('i'), 'SCOPELY'),
    back ? [h('span', { class: 'sep' }), h('a', { class: 'back', href: back.href, text: `← ${back.label}` })] : null);
}

// ------------------------------------------------------------------ router

let leaveGuard = null;
let onEscape = null;
window.addEventListener('beforeunload', (e) => { if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && onEscape && onEscape()) e.preventDefault(); });

async function route() {
  const hsh = location.hash || '#/';
  let m;
  onEscape = null;
  if ((m = hsh.match(/^#\/p\/(\d+)\/setup$/))) return setupView(m[1]);
  if ((m = hsh.match(/^#\/p\/(\d+)$/))) return workspaceView(m[1]);
  leaveGuard = null;
  if ((m = hsh.match(/^#\/f\/(\d+)$/))) return fixView(m[1]);
  // Slice 8: the product shell, its stage feeds and the Case File.
  return shellView(hsh, { setEscape: (fn) => { onEscape = fn; } });
}
window.addEventListener('hashchange', () => {
  if (leaveGuard && leaveGuard() && !confirm('You have unsaved changes. Leave without saving?')) return;
  leaveGuard = null;
  route();
});

// ------------------------------------------------------------------ build website: template select and generation

function generating(business, templateName) {
  const steps = ['Preparing business information', 'Building the page', 'Applying the design', 'Preparing your preview'];
  const items = steps.map((s) => h('li', {}, h('i'), s));
  const fill = h('i');
  const card = h('div', { class: 'gencard', role: 'status', 'aria-live': 'polite' },
    h('h2', { text: `Building ${business}'s website` }), h('p', { class: 'sub', text: `${templateName} · a private draft` }),
    h('div', { class: 'bar' }, fill), h('ol', { class: 'steps' }, items),
    h('p', { class: 'fine', text: 'You can change everything once it’s ready.' }));
  const el = h('div', { class: 'veil' }, card);
  document.body.append(el);
  let i = 0;
  const mark = () => {
    items.forEach((li, j) => { li.className = j < i ? 'done' : j === i ? 'on' : ''; });
    fill.style.width = `${Math.max(8, (i / steps.length) * 100)}%`;
  };
  mark();
  const timer = setInterval(() => { if (i < steps.length - 1) { i++; mark(); } }, 700);
  return {
    async done() { clearInterval(timer); i = steps.length; mark(); await new Promise((r) => setTimeout(r, 380)); el.remove(); },
    failed(message, retry) {
      clearInterval(timer);
      card.replaceChildren(h('h2', { text: 'We couldn’t finish building the page' }),
        h('p', { class: 'sub', text: 'Nothing was saved or shared.' }),
        message ? h('div', { class: 'note error', style: 'margin-top:16px', text: message }) : null,
        h('div', { class: 'acts' }, h('button', { class: 'btn primary', onclick: () => { el.remove(); retry(); } }, 'Try again'),
          h('button', { class: 'btn', onclick: () => el.remove() }, 'Back to templates')));
      card.querySelector('.btn.primary').focus();
    },
  };
}

async function setupView(pid) {
  leaveGuard = null;
  document.title = 'Scopely · Build website';
  let s;
  const back = () => (s ? { href: `#/o/${s.opportunityId}`, label: 'Back to case file' } : { href: '#/', label: 'Back to opportunities' });
  const shell = (...kids) => $app.replaceChildren(appbar(back()), h('main', { class: 'page' }, ...kids));
  shell(h('div', { class: 'boot', style: 'height:50vh' }, h('div', { class: 'spinner' })));
  try { s = await api('GET', `/projects/${pid}/setup`); } catch (err) {
    shell(h('div', { class: 'card empty' }, h('h2', { text: 'This build cannot start yet' }), h('p', { class: 'muted', text: err.message })));
    return;
  }
  if (s.hasVersions) return go(`#/p/${pid}`);
  const t = s.templates[0];
  const problem = s.basis.problem[0];

  async function build(btn) {
    btn.disabled = true;
    const p = generating(s.business.name, t.name);
    try {
      const r = await api('POST', `/projects/${pid}/generate`, { templateKey: t.key });
      if (r.status !== 'SUCCEEDED') { p.failed(r.message, () => build(btn)); btn.disabled = false; return; }
      await p.done();
      go(`#/p/${pid}`);
    } catch (err) { p.failed(err.message, () => build(btn)); btn.disabled = false; }
  }

  const uses = [
    ...s.basis.usedFacts.map((f) => h('li', {}, h('span', { text: cap(f.attribute) }), h('span', { text: cap(f.source.replace(/_/g, ' ')) }))),
    ...s.basis.notUsed.map((n) => h('li', { class: 'no', title: n.why }, h('span', { text: cap(n.what) }), h('span', { text: 'Left out' }))),
  ];
  shell(h('div', { class: 'select' },
    h('div', {},
      h('div', { class: 'eyebrow', text: 'Build website' }),
      h('h1', { text: s.business.name }),
      s.business.websiteUrl ? h('p', { class: 'sub mono', text: s.business.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') }) : null,
      h('div', { class: 'card oppcard' },
        h('span', { class: 'badge amber', text: 'Needs a website' }),
        problem ? h('h2', { text: problem.plainIssue }) : null,
        s.basis.addresses[0] ? h('p', { class: 'small muted', style: 'margin-top:6px', text: s.basis.addresses[0].change }) : null,
        h('div', { class: 'price' }, h('span', { text: s.opportunity.service || s.buildType.name }), h('b', { text: money(s.opportunity.currency, s.opportunity.price) }))),
      h('div', { class: 'uses' },
        h('div', { class: 'label', text: 'What Scopely will use' }),
        uses.length ? h('ul', {}, uses) : h('p', { class: 'foot', text: 'Only the business name. Everything else is left for you to add.' }),
        h('p', { class: 'foot', text: 'Nothing is published. You get a private draft to edit.' }))),
    h('div', {},
      h('h2', { class: 'choose', text: 'Choose a starting design' }),
      h('p', { class: 'muted', style: 'margin-top:6px', text: 'A complete, responsive website. Everything stays editable after it’s built.' }),
      h('div', { class: 'tplcard' },
        h('div', { class: 'tplthumb', 'aria-hidden': 'true' }, h('div', { class: 'mock' },
          h('div', { class: 'mnav' }, h('b', { text: s.business.name }), h('i')),
          h('div', { class: 'mhero' }, h('div', {}, h('small', { text: 'WELCOME' }), h('h4', { text: s.business.name }), h('span', { style: 'width:80%' }), h('span', { style: 'width:55%' }), h('em')),
            h('div', { class: 'mimg' })))),
        h('div', { class: 'tplbody' },
          h('div', { class: 'grow' },
            h('h3', {}, t.name, h('span', { class: 'badge blue', text: 'Best fit' })),
            h('p', { text: t.description }),
            h('p', { class: 'fine', text: `${plural(t.sections.length, 'section', 'sections')} · desktop, tablet and mobile` })),
          h('button', { class: 'btn primary lg', onclick: (e) => build(e.currentTarget) }, `Build with ${t.name}`))))));
}

// ------------------------------------------------------------------ the workspace

const CTA_KINDS = [['unset', 'Not set yet'], ['phone', 'Phone call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['link', 'Web link']];
const CTA_PLACEHOLDER = { phone: '+44 20 7946 0000', whatsapp: '447700900123 (with country code)', email: 'enquiries@business.example', link: 'https://…' };
const CTA_VERB = { phone: 'Calls', whatsapp: 'Opens WhatsApp to', email: 'Emails', link: 'Opens' };
const LINK_STATE = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' };
const SOURCE = { template: 'Suggested by Scopely', business: 'From the business', person: 'Added by you', ai: 'Written by AI', fact: 'From a named source' };
const SUGGEST = ['Make the hero feel more premium', 'Change the main button to WhatsApp', 'Move the reviews higher', 'Use a classic serif', 'Give it more breathing room', 'Hide the gallery'];
const STYLE_LABELS = { button: 'Buttons', spacing: 'Spacing', image: 'Images', backgrounds: 'Section backgrounds' };
const PREVIEW_ONLY = '[data-section]{cursor:auto!important}[data-section]:hover{outline:none!important}[data-section]::after{display:none!important}[data-selected],[data-changed]{outline:none!important}';

async function workspaceView(pid) {
  const S = {
    view: null, ops: [], draft: null, selected: null, tab: 'ai', device: 'desktop', seq: 0, busy: false,
    save: 'saved', ai: null, drawer: false, popover: false, dialog: null, preview: false, sheet: false,
    changed: [], viewedMobile: false, evidenceOpen: false, picker: null, upload: null, showUrl: null,
  };
  leaveGuard = () => S.ops.length > 0;
  $app.replaceChildren(h('div', { class: 'boot' }, h('div', { class: 'spinner' })));

  async function load() {
    const v = await api('GET', `/projects/${pid}/workspace${S.selected ? `?selected=${S.selected}` : ''}`);
    S.view = v; S.ops = []; S.draft = null; S.save = 'saved';
    return v;
  }
  try { await load(); } catch (err) {
    $app.replaceChildren(appbar({ href: '#/', label: 'Back to opportunities' }), h('main', { class: 'page' },
      h('div', { class: 'card empty' }, h('h2', { text: 'This website could not be opened' }), h('p', { class: 'muted', text: err.message }),
        h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => route(), text: 'Try again' })))));
    return;
  }
  if (!S.view.current) return go(`#/p/${pid}/setup`);

  const cur = () => S.view.current;
  const doc = () => (S.draft ? S.draft.document : cur().document);
  const readiness = () => (S.draft ? S.draft.readiness : cur().readiness);
  const tpl = S.view.template;
  const spec = (type) => tpl.sections.find((x) => x.type === type);
  const section = (type) => doc().sections.find((x) => x.type === type);
  const business = S.view.opportunity.business;
  const nextNo = () => cur().versionNo + 1;
  const dirty = () => S.ops.length > 0;
  document.title = `${business} · Website`;

  // ---------------------------------------------------------------- layout
  const $head = h('header', { class: 'wh' });
  const $panel = h('aside', { class: 'lpanel', 'aria-label': 'Edit the website' });
  const $inspector = h('aside', { class: 'inspector', 'aria-label': 'Section', hidden: true });
  const $toolbar = h('div', { class: 'toolbar' });
  const $note = h('div');
  const $iframe = h('iframe', { title: 'Website preview', sandbox: 'allow-same-origin' });
  const $url = h('span', { class: 'url' });
  const $frame = h('div', { class: 'frame desktop' }, h('div', { class: 'chrome', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), $url), $iframe);
  const $busy = h('div', { class: 'busy', hidden: true }, h('div', { class: 'spinner' }), 'Updating');
  const $drawer = h('div', { class: 'drawer', hidden: true, role: 'dialog', 'aria-label': 'Before and after' });
  const $centre = h('section', { class: 'centre', 'aria-label': 'Preview' }, $toolbar, $note, h('div', { class: 'stage' }, $frame, $busy), $drawer);
  const $fab = h('button', { class: 'fab', onclick: () => { S.sheet = true; drawSheets(); } }, 'Edit');
  const $layer = h('div');
  $app.replaceChildren(h('div', { class: 'ws' }, $head, h('div', { class: 'wbody' }, $panel, $centre, $inspector)), $fab, $layer);

  // ---------------------------------------------------------------- preview frame
  let lastHtml = '';
  let keepScroll = true;
  function decorate() {
    const d = $iframe.contentDocument;
    if (!d || !d.body) return;
    d.body.className = `dev-${S.device}`;
    d.querySelectorAll('[data-section]').forEach((el) => {
      const type = el.getAttribute('data-section');
      el.toggleAttribute('data-selected', !S.preview && S.selected === type);
      el.toggleAttribute('data-changed', !S.preview && S.selected !== type && S.changed.includes(type));
    });
    let st = d.getElementById('scopely-preview-only');
    if (S.preview && !st) { st = d.createElement('style'); st.id = 'scopely-preview-only'; st.textContent = PREVIEW_ONLY; d.head.append(st); }
    if (!S.preview && st) st.remove();
  }
  function showPreview(html) {
    if (html === lastHtml) { decorate(); return; }
    const y = keepScroll ? ($iframe.contentWindow?.scrollY ?? 0) : null;
    lastHtml = html;
    $iframe.srcdoc = html;
    $iframe.onload = () => {
      const d = $iframe.contentDocument;
      if (!d) return;
      // The parent attaches the listeners; the preview itself runs no script.
      d.querySelectorAll('[data-section]').forEach((el) => {
        el.addEventListener('click', (e) => { if (S.preview) return; e.preventDefault(); select(el.getAttribute('data-section'), false); }, true);
      });
      d.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { if (a.getAttribute('href')?.startsWith('#')) return; e.preventDefault(); }));
      d.addEventListener('keydown', (e) => { if (e.key === 'Escape' && onEscape) onEscape(); });
      decorate();
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
        const r = await api('POST', `/projects/${pid}/render`, { baseBuildId: cur().buildId, operations: opsForServer(), selected: S.selected });
        if (seq !== S.seq) return;
        S.draft = r;
        showPreview(r.html);
        drawHead();
        // Controls that show document state (an image row, a counter) catch up, unless the person is typing in them.
        if (!typingIn($inspector)) drawInspector();
        if (S.tab !== 'ai' && !typingIn($panel)) drawPanel();
      } catch (err) {
        if (seq !== S.seq) return;
        // The last edit was refused: drop it and say why.
        S.ops.pop();
        if (!S.ops.length) S.save = 'saved';
        fail(err);
        drawAll();
        if (S.ops.length) refresh(0); else { S.draft = null; showPreview(cur().html); }
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
    S.save = 'dirty';
    S.changed = [];
    drawHead();
    refresh();
  }
  const typingIn = (el) => el.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  const opsForServer = () => S.ops.map(({ __key, ...op }) => op);

  function undoUnsaved() {
    if (!S.ops.length) return;
    S.ops.pop();
    if (!S.ops.length) { S.save = 'saved'; S.seq++; S.draft = null; showPreview(cur().html); $busy.hidden = true; }
    else refresh(0);
    drawAll();
  }

  function select(type, scroll = true) {
    S.selected = type;
    S.picker = null; S.upload = null;
    keepScroll = !scroll;
    if (type && S.sheet) S.sheet = false;
    drawToolbar(); drawInspector(); drawPanel(); drawSheets();
    decorate();
    if (scroll && type) $iframe.contentDocument?.querySelector(`[data-section="${type}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function setDevice(d) {
    S.device = d;
    if (d === 'mobile') S.viewedMobile = true;
    $frame.className = `frame ${d}`;
    decorate();
    drawToolbar();
  }

  // ---------------------------------------------------------------- saving, versions, undo
  async function reload(msg) {
    await load();
    lastHtml = '';
    showPreview(cur().html);
    drawAll();
    if (msg) toast(msg);
  }

  /** Stores the pending edits as a new version. Returns false if it could not. */
  async function save(opts = {}) {
    if (!S.ops.length) return true;
    const from = cur().buildId;
    S.busy = true; S.save = 'saving'; drawHead();
    try {
      await api('POST', `/projects/${pid}/save`, { baseBuildId: from, operations: opsForServer() });
      await reload();
      if (!opts.quiet) toast(`Saved as version ${cur().versionNo}`, { action: { label: 'Undo', run: () => undoVersion(from) } });
      return true;
    } catch (err) {
      S.save = 'error'; fail(err); return false;
    } finally { S.busy = false; drawHead(); }
  }

  /** Undo never deletes: it restores the previous version as a new version. */
  async function undoVersion(fromBuildId) {
    if (dirty() && !confirm('Undo discards your unsaved changes too. Continue?')) return;
    try {
      const r = await api('POST', `/projects/${pid}/restore`, { baseBuildId: cur().buildId, fromBuildId, undo: true });
      S.changed = []; S.ai = null;
      await reload();
      toast(`Undone. Version ${r.versionNo} restores the previous one.`);
    } catch (err) { fail(err); }
  }

  async function restore(v) {
    if (dirty() && !confirm('Restoring discards your unsaved changes. Continue?')) return;
    const from = cur().buildId;
    try {
      const r = await api('POST', `/projects/${pid}/restore`, { baseBuildId: from, fromBuildId: v.buildId });
      S.popover = false; S.changed = []; S.ai = null;
      await reload();
      drawLayer();
      toast(`Version ${v.versionNo} restored as version ${r.versionNo}`, { action: { label: 'Undo', run: () => undoVersion(from) } });
    } catch (err) { fail(err); }
  }

  // ---------------------------------------------------------------- header
  function statusBadge() {
    const c = cur();
    const approved = S.view.versions.find((v) => v.status === 'APPROVED' || v.status === 'SHOWN');
    if (c.status === 'SHOWN') return h('span', { class: 'status shown', text: `Shown · v${c.versionNo}` });
    if (c.status === 'APPROVED') return h('span', { class: 'status approved', text: `Approved · v${c.versionNo}` });
    return h('span', { class: 'status', text: approved ? `Draft · v${approved.versionNo} approved` : 'Draft' });
  }
  function saveIndicator() {
    if (S.save === 'saving') return h('span', { class: 'saveind dirty', role: 'status' }, h('div', { class: 'spinner', style: 'width:12px;height:12px' }), h('span', { class: 'word', text: 'Saving…' }));
    if (S.save === 'error') return h('span', { class: 'saveind error', role: 'status' }, h('i'), h('span', { class: 'word', text: 'Couldn’t save' }), h('button', { class: 'btn sm', onclick: () => save() }, 'Retry'));
    if (dirty()) return h('span', { class: 'saveind dirty', role: 'status' }, h('i'), h('span', { class: 'word', text: 'Unsaved changes' }),
      h('button', { class: 'btn sm', disabled: S.busy, onclick: () => save() }, `Save as version ${nextNo()}`));
    return h('span', { class: 'saveind', role: 'status' }, h('i'), h('span', { class: 'word', text: 'Saved' }));
  }
  function drawHead() {
    const c = cur();
    let primary;
    if (c.status === 'DRAFT' || dirty()) primary = h('button', { class: 'btn primary', disabled: S.busy, onclick: () => openDialog('approve') }, dirty() && c.status === 'DRAFT' ? 'Approve' : dirty() ? `Approve version ${nextNo()}` : 'Approve');
    else primary = h('button', { class: 'btn dark', disabled: S.busy, onclick: () => openDialog('show') }, c.status === 'APPROVED' ? 'Show to owner' : 'Show again');
    $head.replaceChildren(
      h('button', { class: 'backbtn', title: 'Back to case file', 'aria-label': 'Back to case file', onclick: () => go(`#/o/${S.view.opportunity.opportunityId}`) }, icon('back')),
      h('div', { class: 'crumb' }, h('small', { text: `${business} · Needs a website` }), h('strong', { text: `Website · ${tpl.name}` })),
      h('span', { class: 'vsep' }),
      h('button', { class: 'verbtn', 'aria-haspopup': 'dialog', 'aria-expanded': String(S.popover), onclick: (e) => { S.popover = !S.popover; drawLayer(e.currentTarget); } },
        `Version ${c.versionNo}`),
      saveIndicator(),
      h('div', { class: 'acts' }, statusBadge(), h('button', { class: 'btn', onclick: () => setPreview(true) }, 'Preview'), primary));
  }

  // ---------------------------------------------------------------- toolbar
  function devices() {
    return h('div', { class: 'seg', role: 'group', 'aria-label': 'Preview size' },
      [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Mobile']].map(([k, l]) => h('button', { 'aria-pressed': String(S.device === k), onclick: () => setDevice(k) }, l)));
  }
  function drawToolbar() {
    $url.textContent = `${slugOf(business)} · ${S.preview ? `version ${cur().versionNo}` : 'private draft'}`;
    if (S.preview) {
      const c = cur();
      $toolbar.className = 'pvbar';
      $toolbar.replaceChildren(
        h('div', { class: 't' }, dirty() ? 'Previewing unsaved changes ' : `Previewing Version ${c.versionNo} `,
          h('span', { text: dirty() ? `· based on version ${c.versionNo}` : `· ${c.status === 'DRAFT' ? 'Draft' : c.status === 'APPROVED' ? 'Approved' : 'Shown'}` })),
        devices(),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', title: 'Open the saved version on its own, in a new tab', onclick: openInTab }, 'Open in new tab'),
          h('button', { class: 'btn', onclick: () => setPreview(false) }, 'Exit preview')));
      return;
    }
    $toolbar.className = 'toolbar';
    $toolbar.replaceChildren(
      h('button', { class: 'found', 'aria-expanded': String(S.drawer), onclick: () => { S.drawer = !S.drawer; drawDrawer(); drawToolbar(); } }, h('span', { text: 'What Scopely found' })),
      devices(),
      h('p', { class: 'hint', text: S.selected ? `Editing ${spec(S.selected).name.toLowerCase()}` : 'Click any section to edit' }));
    $note.replaceChildren(cur().upgraded ? h('div', { class: 'note amber upgraded' },
      `Version ${cur().versionNo} was made with the earlier Meridian look. You are seeing the current look; your next version is made with it. Version ${cur().versionNo} itself does not change.`) : '');
  }

  function setPreview(on) {
    S.preview = on;
    if (on) { S.drawer = false; S.popover = false; S.sheet = false; }
    $panel.hidden = on;
    $note.hidden = on;
    $panel.parentElement.classList.toggle('pv', on);
    drawToolbar(); drawDrawer(); drawInspector(); drawLayer(); decorate();
  }

  async function openInTab() {
    const win = window.open('', '_blank', 'noopener');
    try {
      const r = await api('POST', `/projects/${pid}/versions/${cur().buildId}/link`, { kind: 'edit' });
      if (win) win.location = r.url; else location.href = r.url;
      if (dirty()) toast('The new tab shows the last saved version. Save to include your changes.');
    } catch (err) { win?.close(); fail(err); }
  }

  // ---------------------------------------------------------------- the Before → After drawer
  function drawDrawer() {
    $drawer.hidden = !S.drawer || S.preview;
    if ($drawer.hidden) return;
    const b = doc().basis;
    const o = S.view.opportunity;
    const ev = b.problem[0];
    const secOf = (text) => /button|next step|book|enquir/i.test(text) ? 'hero' : /contact|reach/i.test(text) ? 'contact' : /review|rating/i.test(text) ? 'proof' : /service/i.test(text) ? 'services' : 'hero';
    $drawer.replaceChildren(
      h('header', {}, h('h2', { text: 'Before → After' }), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: () => { S.drawer = false; drawDrawer(); drawToolbar(); } }, icon('close'))),
      h('div', { class: 'dbody' },
        h('div', { class: 'blk' }, h('div', { class: 'label', text: 'Before · what Scopely found' }),
          h('span', { class: 'badge amber', text: 'Needs a website' }),
          ev ? [h('h3', { text: ev.plainIssue }),
            h('button', { class: 'btn link', style: 'margin-top:10px;font-size:12.5px', 'aria-expanded': String(S.evidenceOpen), onclick: () => { S.evidenceOpen = !S.evidenceOpen; drawDrawer(); } },
              S.evidenceOpen ? 'Hide evidence ▲' : 'Show evidence ▼'),
            S.evidenceOpen ? b.problem.map((e) => h('div', { class: 'ev' }, h('dl', {},
              h('dt', { text: 'URL' }), h('dd', { class: 'mono', text: e.url }),
              h('dt', { text: 'Quote' }), h('dd', { text: `“${e.quote}”` }),
              h('dt', { text: 'Captured' }), h('dd', { class: 'mono', text: new Date(e.observedAt).toUTCString().replace(/:\d\d GMT$/, ' UTC') }),
              h('dt', { text: 'Status' }), h('dd', { class: 'ok', text: `${claimWord[e.claimState] || e.claimState} · ${confidenceWord[e.confidence] || ''}` })))) : null]
            : h('p', { class: 'muted small', text: 'No observed problem is attached.' })),
        h('div', { class: 'blk after' }, h('div', { class: 'label', text: 'After · what this build adds' }),
          b.addresses.map((a) => {
            const t = secOf(a.change);
            return h('button', { class: 'addrow', onclick: () => { S.drawer = false; drawDrawer(); select(t); } },
              h('div', { class: 'grow' }, h('b', { text: spec(t).name }), h('span', { text: a.change })));
          }),
          h('div', { class: 'price' }, h('span', { text: o.service || 'Service' }), h('b', { text: money(o.currency, o.price) })))));
  }

  // ---------------------------------------------------------------- left panel
  const TABS = [['ai', 'AI'], ['sections', 'Sections'], ['design', 'Design'], ['settings', 'Settings']];
  function drawPanel() {
    const sc = $panel.querySelector('.pbody')?.scrollTop ?? 0;
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(S.tab === k),
      onclick: () => { S.tab = k; drawPanel(); } }, k === 'ai' ? h('span', { class: 'spark', text: '✦' }) : null, l)));
    const body = { ai: aiTab, sections: sectionsTab, design: designTab, settings: settingsTab }[S.tab]();
    $panel.replaceChildren(tabs, ...body);
    const pb = $panel.querySelector('.pbody');
    if (pb) pb.scrollTop = sc;
  }

  // AI
  async function runAi(request) {
    const text = request.trim();
    if (!text || S.busy) return;
    const scope = S.selected ? spec(S.selected).name : null;
    const full = scope && !text.toLowerCase().includes(scope.toLowerCase()) ? `${scope}: ${text}` : text;
    S.busy = true;
    S.ai = { phase: 'working', request: text };
    drawPanel(); drawHead();
    try {
      if (dirty() && !(await save({ quiet: true }))) { S.ai = null; return; }
      const from = cur().buildId;
      const r = await api('POST', `/projects/${pid}/ai-edit`, { baseBuildId: from, request: full });
      if (r.status !== 'SUCCEEDED') { S.ai = { phase: 'error', request: text, message: r.message }; return; }
      await reload();
      const changes = cur().document.lastEdit.changes || [];
      S.changed = [...new Set(changes.map((c) => c.section).filter((s) => s !== 'page'))];
      S.ai = { phase: 'done', request: text, from, versionNo: cur().versionNo };
      decorate();
      toast(`Applied as version ${cur().versionNo}`, { action: { label: 'Undo', run: () => undoVersion(from) } });
    } catch (err) {
      S.ai = { phase: 'error', request: text, message: err.message };
    } finally { S.busy = false; drawPanel(); drawHead(); }
  }

  function aiTab() {
    const box = h('textarea', { rows: 2, maxlength: 500, placeholder: S.selected ? `Change the ${spec(S.selected).name.toLowerCase()}…` : 'e.g. Make the hero feel more premium',
      'aria-label': 'Describe a change', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAi(box.value); } } });
    const last = cur().document.lastEdit;
    let card = null;
    if (S.ai?.phase === 'working') {
      card = h('div', { class: 'aicard', role: 'status' }, h('div', { class: 'working' }, h('div', { class: 'spinner' }), 'Working on it…'),
        h('p', { class: 'req', text: `“${S.ai.request}”` }));
    } else if (S.ai?.phase === 'error') {
      card = h('div', { class: 'aicard error', role: 'alert' }, h('h3', { text: 'Nothing was changed' }), h('p', { class: 'small', style: 'margin-top:4px', text: S.ai.message }),
        h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: () => { const r = S.ai.request; S.ai = null; drawPanel(); const b = $panel.querySelector('.composer textarea'); b.value = r; b.focus(); } }, 'Edit request')));
    } else if (S.ai?.phase === 'done' && last.by === 'ai' && cur().versionNo === S.ai.versionNo) {
      const changes = last.changes || [];
      card = h('div', { class: 'aicard' },
        h('h3', { text: `Applied as version ${S.ai.versionNo}` }), h('p', { class: 'req', text: `“${S.ai.request}”` }),
        changes.length ? h('ul', { class: 'changes' }, changes.map((c) => h('li', {}, h('b', { text: c.label }),
          h('span', { class: 'ft' }, h('s', { text: c.from }), ' → ', c.to))))
          : h('ul', { class: 'changes' }, last.applied.map((a) => h('li', {}, a))),
        last.needsInput.map((q) => h('div', { class: 'note amber', style: 'margin-top:10px' }, q,
          h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: () => { S.tab = 'settings'; drawPanel(); } }, 'Add it now')))),
        h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: () => undoVersion(S.ai.from) }, 'Undo'),
          h('button', { class: 'btn sm ghost', onclick: () => { S.ai = null; S.changed = []; decorate(); drawPanel(); } }, 'Done')));
    }
    const applied = S.view.versions.filter((v) => v.kind === 'ai');
    return [
      h('div', { class: 'pbody' },
        h('p', { class: 'pintro', text: 'Describe a change. Scopely makes it as a new version you can undo, and never adds a claim it can’t back up.' }),
        S.selected ? h('div', { class: 'scope' }, 'Editing: ', h('b', { text: spec(S.selected).name }),
          h('button', { 'aria-label': 'Edit the whole page instead', onclick: () => select(null) }, '×')) : null,
        card,
        h('div', { class: 'label plabel', text: 'Try' }),
        h('div', { class: 'suggest' }, SUGGEST.map((s) => h('button', { disabled: S.busy, onclick: () => runAi(s) }, s))),
        h('div', { class: 'label plabel', style: 'margin-top:24px', text: 'Applied edits' }),
        applied.length ? h('div', { class: 'applied' }, applied.map((v) => h('div', {}, v.summary.replace(/^AI edit: /, '').split('. Needs you')[0],
          h('small', { text: `Version ${v.versionNo} · ${when(v.createdAt)}` }))))
          : h('p', { class: 'empty-text', text: 'AI edits you apply appear here, each as a new version.' })),
      h('div', { class: 'composer' }, h('div', { class: 'box' }, box,
        h('div', { class: 'foot' }, h('span', { text: 'Enter to send' }), h('button', { class: 'btn primary sm', disabled: S.busy, onclick: () => runAi(box.value) }, 'Apply change')))),
    ];
  }

  // Sections
  function sectionsTab() {
    const secs = doc().sections;
    return [h('div', { class: 'pbody' },
      h('p', { class: 'pintro', text: 'Page sections, top to bottom. Select one to edit it.' }),
      secs.map((s, i) => {
        const sp = spec(s.type);
        const noData = sp.factBound === 'reviews' && !doc().facts.reviews;
        const canToggle = sp.hideable && !(noData && !s.visible);
        const prev = secs[i - 1]; const next = secs[i + 1];
        const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
        return h('div', { class: `secrow ${S.selected === s.type ? 'on' : ''} ${s.visible ? '' : 'off'}`, role: 'button', tabindex: 0,
          onclick: () => select(s.type), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) select(s.type); } },
          h('span', { class: 'n', text: String(i + 1).padStart(2, '0') }),
          h('span', { class: 'nm' }, sp.name, noData ? h('span', { class: 'why', text: ' · no sourced reviews' }) : null),
          sp.movable ? [
            h('button', { class: 'iconbtn', 'aria-label': `Move ${sp.name} up`, disabled: !prev || !spec(prev.type).movable,
              onclick: stop(() => { edit({ op: 'move_section', section: s.type, direction: 'up' }); drawPanel(); }) }, icon('up')),
            h('button', { class: 'iconbtn', 'aria-label': `Move ${sp.name} down`, disabled: !next || !spec(next.type).movable,
              onclick: stop(() => { edit({ op: 'move_section', section: s.type, direction: 'down' }); drawPanel(); }) }, icon('down'))] : null,
          h('button', { class: 'iconbtn', 'aria-label': `${s.visible ? 'Hide' : 'Show'} ${sp.name}`, disabled: !canToggle,
            title: !sp.hideable ? 'Always shown' : noData ? 'No sourced review data' : s.visible ? 'Hide' : 'Show',
            onclick: stop(() => { edit({ op: s.visible ? 'hide_section' : 'show_section', section: s.type }); drawPanel(); drawInspector(); }) }, icon(s.visible ? 'eye' : 'eyeoff')));
      }),
      h('p', { class: 'footnote', text: 'Hidden sections stay in your draft but aren’t shown on the website. The hero stays first and the footer last.' }))];
  }

  // Design
  function segmented(label, options, value, onPick) {
    return h('div', { role: 'group', 'aria-label': label }, h('div', { class: 'label plabel', style: 'margin-top:22px', text: label }),
      h('div', { class: 'seg full' }, options.map((o) => h('button', { 'aria-pressed': String(value === o.key), onclick: () => onPick(o.key) }, o.name))));
  }
  function designTab() {
    const th = doc().theme;
    return [h('div', { class: 'pbody' },
      h('p', { class: 'pintro', text: 'Design changes apply across the whole page.' }),
      h('div', { class: 'label plabel', text: 'Typography' }),
      h('div', { class: 'types' }, tpl.fonts.map((f) => h('button', { class: 'typecard', 'aria-pressed': String(th.fonts === f.key),
        onclick: () => { edit({ op: 'change_font', fonts: f.key }); drawPanel(); } },
        h('b', { style: `font-family:${f.heading};font-weight:${f.headingWeight}`, text: 'Aa' }),
        h('span', {}, h('strong', { text: f.name }), h('small', { text: f.description || '' }))))),
      h('div', { class: 'label plabel', style: 'margin-top:22px', text: 'Colour' }),
      h('div', { class: 'colors' }, tpl.palettes.map((p) => h('button', { class: 'colorcard', 'aria-pressed': String(th.palette === p.key),
        onclick: () => { edit({ op: 'change_color', palette: p.key }); drawPanel(); } },
        h('div', { class: 'sw' }, [p.bg, p.tint || p.surface, p.accent, p.ink].map((c) => h('span', { style: `background:${c}` }))), p.name))),
      th.accent ? h('p', { class: 'hint' }, 'A custom accent colour is set. ', h('button', { class: 'btn link', onclick: () => { edit({ op: 'change_color', accent: null }); drawPanel(); } }, 'Use the scheme’s colour')) : null,
      tpl.styles ? Object.keys(STYLE_LABELS).map((k) => segmented(STYLE_LABELS[k], tpl.styles[k], th[k], (v) => { edit({ op: 'change_style', [k]: v }); drawPanel(); })) : null)];
  }

  // Settings
  function ctaFields() {
    const cta = doc().cta;
    const kind = cta.action.kind;
    let pendingKind = kind;
    const value = h('input', { type: 'text', value: cta.action.value || '', placeholder: CTA_PLACEHOLDER[kind] || '', disabled: kind === 'unset', 'aria-label': 'Number, address or link' });
    const kindSel = h('select', { 'aria-label': 'Where the main button goes', onchange: (e) => {
      pendingKind = e.target.value;
      value.disabled = pendingKind === 'unset';
      value.placeholder = CTA_PLACEHOLDER[pendingKind] || '';
      value.value = '';
      if (pendingKind === 'unset') edit({ op: 'update_cta', action: { kind: 'unset' } }, 'cta-action');
      else value.focus();
    } }, CTA_KINDS.map(([k, l]) => h('option', { value: k, selected: k === kind }, l)));
    value.addEventListener('change', () => { if (value.value.trim()) edit({ op: 'update_cta', action: { kind: pendingKind, value: value.value } }, 'cta-action'); });
    return [
      h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Main button', h('em', { text: SOURCE[doc().provenance.cta] || '' })),
        h('input', { type: 'text', value: cta.label, maxlength: 32, oninput: (e) => edit({ op: 'update_cta', label: e.target.value }, 'cta-label') })),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Button goes to', kind === 'unset' ? h('em', { style: 'color:var(--amber-text)', text: 'Needed before showing' }) : null), kindSel),
      h('div', { class: 'field', style: 'margin-top:8px' }, value, h('p', { class: 'hint', text: 'Use details the business really uses. The button appears in the header, the hero, the call to action, the contact section and a bar on phones.' })),
    ];
  }
  function settingsTab() {
    return [h('div', { class: 'pbody' },
      h('p', { class: 'pintro', text: 'Business details are used everywhere on the page, so they only need changing once.' }),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Business name', h('em', { text: 'From the opportunity' })), h('input', { type: 'text', value: doc().brand.name, readonly: true })),
      ctaFields(),
      h('div', { class: 'fgroup' }, itemsField('contact', 'details', spec('contact').slots.details)),
      textField('footer', 'note', spec('footer').slots.note),
      h('div', { class: 'lock' }, icon('lock'), h('span', { text: 'Your connected AI credentials are never included in your website.' })))];
  }

  // ---------------------------------------------------------------- fields (inspector and settings)
  function textField(sec, slot, sp) {
    const val = String(section(sec).content[slot] ?? '');
    const src = SOURCE[doc().provenance[`${sec}.${slot}`]];
    const count = h('em', { text: src || `${val.length}/${sp.maxLength}` });
    const attrs = { maxlength: sp.maxLength, placeholder: sp.placeholder,
      oninput: (e) => { count.textContent = `${e.target.value.length}/${sp.maxLength}`; edit({ op: 'update_text', section: sec, slot, value: e.target.value }, `t:${sec}.${slot}`); } };
    const input = sp.multiline ? h('textarea', { ...attrs, rows: slot === 'body' ? 6 : 3 }, val) : h('input', { type: 'text', value: val, ...attrs });
    return h('label', { class: 'field' }, h('span', { class: 'lab' }, sp.label, count), input);
  }

  function itemsField(sec, slot, sp) {
    const items = () => (section(sec).content[slot] || []).map((x) => ({ ...x }));
    const commit = (list) => edit({ op: 'update_items', section: sec, slot, items: list }, `i:${sec}.${slot}`);
    const [ft, fx] = sp.fields;
    const rows = items().map((it, i) => h('div', { class: 'item' },
      h('div', { class: 'row' }, h('input', { type: 'text', value: it.title, maxlength: ft.maxLength, placeholder: ft.label, 'aria-label': ft.label,
        oninput: (e) => { const l = items(); l[i].title = e.target.value; commit(l); } }),
        h('button', { class: 'iconbtn', 'aria-label': `Remove ${it.title || 'entry'}`, onclick: () => { const l = items(); l.splice(i, 1); commit(l); drawInspector(); drawPanel(); } }, icon('close'))),
      h('input', { type: 'text', value: it.text, maxlength: fx.maxLength, placeholder: `${fx.label} (optional)`, 'aria-label': fx.label,
        oninput: (e) => { const l = items(); l[i].text = e.target.value; commit(l); } })));
    const full = items().length >= sp.max;
    return h('div', {}, h('div', { class: 'field' }, h('span', { class: 'lab' }, sp.label, h('em', { text: `${items().length}/${sp.max}` }))),
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
    row.addEventListener('focusout', (e) => { if (index !== null && !row.contains(e.relatedTarget)) { drawInspector(); drawPanel(); } });
    button.before(row);
    button.disabled = true;
    title.focus();
  }

  function picker(key, onPick, chosen, multi) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'sr', onchange: (e) => {
      const f = e.target.files[0];
      if (!f) return;
      S.upload = { key, file: f, description: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') };
      drawInspector();
    } });
    let form = null;
    if (S.upload?.key === key) {
      const desc = h('input', { type: 'text', value: S.upload.description, maxlength: 200 });
      form = h('div', { class: 'upform' }, h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Describe this photo'), desc,
        h('p', { class: 'hint', text: 'This becomes the alt text people using screen readers hear.' })),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn primary sm', onclick: async (e) => {
            if (!desc.value.trim()) { desc.focus(); return; }
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              if (dirty() && !(await save({ quiet: true }))) { btn.disabled = false; return; }
              const r = await api('POST', `/projects/${pid}/images`, S.upload.file, { 'content-type': 'application/octet-stream', 'x-description': encodeURIComponent(desc.value.trim()) });
              S.upload = null;
              await reload('Photo added');
              onPick(r.assetId);
            } catch (err) { fail(err); btn.disabled = false; }
          } }, 'Add photo'),
          h('button', { class: 'btn sm ghost', onclick: () => { S.upload = null; drawInspector(); } }, 'Cancel')));
    }
    return h('div', { class: 'picker' },
      h('div', { class: 'imgs' },
        S.view.images.map((im) => {
          const idx = multi ? chosen.indexOf(im.assetId) : (chosen === im.assetId ? 0 : -1);
          return h('button', { class: `img ${idx >= 0 ? 'on' : ''}`, title: im.description, 'aria-pressed': String(idx >= 0), onclick: () => onPick(im.assetId) },
            h('img', { src: im.dataUrl, alt: im.description }), multi && idx >= 0 ? h('span', { class: 'n', text: String(idx + 1) }) : null);
        }),
        h('label', { class: 'img add' }, input, '+ Upload')),
      form,
      h('p', { class: 'hint', text: multi ? 'Tap photos in the order they should appear. Tap again to remove.' : 'Only real photos you or the business supplied.' }));
  }

  function imageField(sec, slot, sp) {
    const curId = section(sec).content[slot];
    const im = S.view.images.find((x) => x.assetId === curId);
    const key = `${sec}.${slot}`;
    return h('div', { class: 'fgroup' }, h('div', { class: 'field' }, h('span', { class: 'lab' }, sp.label)),
      h('div', { class: 'imgrow' }, h('div', { class: 'th' }, im ? h('img', { src: im.dataUrl, alt: '' }) : null),
        h('div', { class: 'grow' }, im ? im.description : 'No photo yet', h('small', { text: im ? 'Supplied by you' : 'A calm placeholder shows until you add one' })),
        h('button', { class: 'btn sm', 'aria-expanded': String(S.picker === key), onclick: () => { S.picker = S.picker === key ? null : key; drawInspector(); } }, im ? 'Replace' : 'Choose')),
      S.picker === key ? [picker(key, (id) => { edit({ op: 'replace_image', section: sec, slot, assetId: id }); S.picker = null; drawInspector(); }, curId, false),
        im ? h('button', { class: 'btn sm ghost danger', style: 'margin-top:6px', onclick: () => { edit({ op: 'replace_image', section: sec, slot, assetId: null }); S.picker = null; drawInspector(); } }, 'Remove photo') : null] : null);
  }

  function galleryField(sec, slot, sp) {
    const curIds = [...(section(sec).content[slot] || [])];
    return h('div', { class: 'fgroup' }, h('div', { class: 'field' }, h('span', { class: 'lab' }, sp.label, h('em', { text: `${curIds.length}/${sp.max}` }))),
      picker(`${sec}.${slot}`, (id) => {
        const next = curIds.includes(id) ? curIds.filter((x) => x !== id) : [...curIds, id];
        edit({ op: 'set_images', section: sec, slot, assetIds: next }); drawInspector();
      }, curIds, true));
  }

  // ---------------------------------------------------------------- right inspector
  function openSettings() { S.tab = 'settings'; S.sheet = true; drawPanel(); drawSheets(); }
  function drawInspector() {
    $inspector.hidden = !S.selected || S.preview;
    if ($inspector.hidden) { drawSheets(); return; }
    const sc = $inspector.querySelector('.ibody')?.scrollTop ?? 0;
    const sp = spec(S.selected);
    const sec = section(S.selected);
    const fields = [];
    if (sp.factBound === 'reviews') {
      const r = doc().facts.reviews;
      fields.push(h('div', { class: `note ${r ? 'sage' : 'amber'}`, style: 'margin-bottom:16px', text: r
        ? `Shows ${r.rating ?? ''}${r.rating ? ' out of 5' : ''}${r.count !== null ? ` from ${r.count} reviews` : ''} as reported by ${r.source.replace(/_/g, ' ')}${r.asOf ? ` on ${date(r.asOf)}` : ''}. Ratings come only from a named source and can’t be typed in.`
        : 'There is no sourced review data for this business, so this section stays hidden. Ratings and reviews are never written by hand or by AI.' }));
    }
    if (S.selected === 'cta' || S.selected === 'contact') {
      fields.push(h('p', { class: 'hint', style: 'margin:0 0 16px' }, `The main button (“${doc().cta.label}”) appears here. `, h('button', { class: 'btn link', onclick: openSettings }, 'Change it in Settings')));
    }
    for (const [slot, s] of Object.entries(sp.slots)) {
      if (s.kind === 'text') fields.push(textField(S.selected, slot, s));
      else if (s.kind === 'items') fields.push(h('div', { class: 'fgroup' }, itemsField(S.selected, slot, s)));
      else if (s.kind === 'image') fields.push(imageField(S.selected, slot, s));
      else if (s.kind === 'images') fields.push(galleryField(S.selected, slot, s));
      if (S.selected === 'hero' && slot === 'subheadline') {
        fields.push(h('div', { class: 'field' }, h('label', { class: 'lab', for: 'hero-cta' }, 'Main button', h('em', { text: SOURCE[doc().provenance.cta] || '' })),
          h('input', { id: 'hero-cta', type: 'text', value: doc().cta.label, maxlength: 32, oninput: (e) => edit({ op: 'update_cta', label: e.target.value }, 'cta-label') }),
          h('p', { class: 'hint' }, doc().cta.action.kind === 'unset' ? 'No destination yet. ' : `${CTA_VERB[doc().cta.action.kind]} ${doc().cta.action.value}. `,
            h('button', { class: 'btn link', onclick: openSettings }, 'Change in Settings'))));
      }
    }
    if (sp.variants) {
      fields.push(h('div', { class: 'fgroup' }, h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Layout')),
        h('div', { class: 'seg full', role: 'group', 'aria-label': 'Layout' }, sp.variants.map((v) => h('button', { 'aria-pressed': String(sec.variant === v.key),
          onclick: () => { edit({ op: 'change_layout', section: S.selected, variant: v.key }); drawInspector(); } }, v.name)))));
    }
    const noData = sp.factBound === 'reviews' && !doc().facts.reviews;
    $inspector.replaceChildren(
      h('header', {}, h('div', {}, h('div', { class: 'label', text: 'Section' }), h('h2', { text: sp.name })),
        h('button', { class: 'iconbtn', 'aria-label': 'Close section', onclick: () => select(null) }, icon('close'))),
      h('div', { class: 'ibody' },
        h('p', { class: 'purpose', text: sp.purpose }),
        fields,
        h('div', { class: 'showrow' }, h('div', {}, h('b', { text: 'Show on website' }), h('small', { text: !sp.hideable ? 'Always shown' : sec.visible ? 'Visible' : 'Hidden' })),
          h('button', { class: 'switch', role: 'switch', 'aria-checked': String(sec.visible), 'aria-label': `Show ${sp.name} on the website`, disabled: !sp.hideable || (noData && !sec.visible),
            onclick: () => { edit({ op: sec.visible ? 'hide_section' : 'show_section', section: S.selected }); drawInspector(); drawPanel(); } })),
        h('button', { class: 'btn block askai', onclick: () => { S.tab = 'ai'; S.sheet = true; drawPanel(); drawSheets(); $panel.querySelector('.composer textarea')?.focus(); } },
          h('span', { style: 'color:var(--amber)', text: '✦' }), 'Ask AI to change this section')));
    const ib = $inspector.querySelector('.ibody');
    if (ib) ib.scrollTop = sc;
    drawSheets();
  }

  // Below 1000px the panels are bottom sheets.
  const narrowQuery = matchMedia('(max-width: 1000px)');
  function drawSheets() {
    const narrow = narrowQuery.matches;
    $panel.classList.toggle('open', narrow && S.sheet);
    $inspector.classList.toggle('open', narrow && Boolean(S.selected) && !S.sheet);
    $fab.hidden = S.preview || (narrow && (S.sheet || Boolean(S.selected)));
  }
  narrowQuery.addEventListener('change', drawSheets);

  // ---------------------------------------------------------------- version history popover and dialogs
  function versionWhat(v) {
    if (v.kind === 'build') return 'Initial build';
    if (v.kind === 'ai') return `AI · ${v.summary.replace(/^AI edit: /, '').split('. Needs you')[0]}`;
    if (v.kind === 'restore') return v.summary;
    return 'Edited by you';
  }
  let offOutside = null;
  function drawLayer(anchor) {
    if (offOutside) { document.removeEventListener('mousedown', offOutside); offOutside = null; }
    if (S.popover && !S.preview) {
      const c = cur();
      const r = (anchor || $head.querySelector('.verbtn')).getBoundingClientRect();
      const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Version history', style: `left:${Math.max(8, Math.min(r.left, innerWidth - 348))}px;top:${r.bottom + 8}px` },
        h('header', {}, h('h2', { text: 'Version history' }), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: () => { S.popover = false; drawLayer(); } }, icon('close'))),
        h('div', { class: 'vlist' }, S.view.versions.map((v) => h('div', { class: `vrow ${v.buildId === c.buildId ? 'cur' : ''}` },
          h('div', { class: 'grow' },
            h('h3', {}, `Version ${v.versionNo}`, v.buildId === c.buildId ? h('span', { class: 'badge ink', text: 'Current' }) : null,
              v.status === 'APPROVED' ? h('span', { class: 'badge blue', text: 'Approved' }) : null, v.status === 'SHOWN' ? h('span', { class: 'badge sage', text: 'Shown' }) : null),
            h('div', { class: 'what', text: versionWhat(v) }),
            v.approvedBy ? h('div', { class: 'req', text: `Approved by ${v.approvedBy}` }) : null,
            h('time', { datetime: v.createdAt, text: when(v.createdAt) })),
          v.buildId !== c.buildId ? h('button', { class: 'btn sm', disabled: S.busy, onclick: () => restore(v) }, 'Restore') : null))),
        h('footer', {}, dirty()
          ? h('button', { class: 'btn primary block', disabled: S.busy, onclick: async () => { if (await save()) { S.popover = false; drawLayer(); } } }, `Save current edits as version ${nextNo()}`)
          : 'Every save, AI edit and restore makes a new version. Restoring never deletes one; approved and shown versions never change.'));
      $layer.replaceChildren(pop);
      pop.querySelector('.iconbtn').focus();
      offOutside = (e) => { if (!pop.contains(e.target) && !e.target.closest?.('.verbtn')) { S.popover = false; drawLayer(); } };
      setTimeout(() => { if (offOutside) document.addEventListener('mousedown', offOutside); }, 0);
    } else if (S.dialog) {
      $layer.replaceChildren(S.dialog === 'approve' ? approveDialog() : showDialog());
      $layer.querySelector('.dialog input:not([readonly]), .dialog .btn.primary, .dialog .btn.dark')?.focus();
    } else {
      $layer.replaceChildren();
    }
    drawHead();
  }
  function openDialog(which) { S.dialog = which; S.popover = false; drawLayer(); }
  function closeDialog() { S.dialog = null; drawLayer(); }
  const scrim = (dialog) => h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === e.currentTarget) closeDialog(); } }, dialog);

  function approveDialog() {
    const c = cur();
    const no = dirty() ? nextNo() : c.versionNo;
    const items = readiness();
    const cta = doc().cta.action;
    const name = h('input', { type: 'text', value: remember('scopely.approver'), placeholder: 'Your name', maxlength: 120, autocomplete: 'name' });
    const fix = (it) => () => { closeDialog(); if (it.section === 'cta') openSettings(); else select(it.section); };
    const checks = [
      ...items.map((it) => h('li', { class: 'todo' }, h('i'), h('span', { text: it.message }), h('button', { class: 'btn sm', onclick: fix(it) }, 'Fix'))),
      cta.kind !== 'unset' ? h('li', { class: 'ok' }, h('i'), h('span', { text: `Main button ${CTA_VERB[cta.kind].toLowerCase()} ${cta.value}` })) : null,
      h('li', { class: 'ok' }, h('i'), h('span', { text: 'Every stated fact has a source' })),
      S.viewedMobile ? h('li', { class: 'ok' }, h('i'), h('span', { text: 'Checked on mobile' }))
        : h('li', { class: 'todo' }, h('i'), h('span', { text: 'Not checked on mobile yet' }), h('button', { class: 'btn sm', onclick: () => { closeDialog(); setDevice('mobile'); } }, 'Preview on mobile')),
    ];
    const go_ = h('button', { class: 'btn primary', onclick: async () => {
      if (!name.value.trim()) { name.focus(); return; }
      remember('scopely.approver', name.value.trim());
      go_.disabled = true;
      try {
        if (dirty() && !(await save({ quiet: true }))) { go_.disabled = false; return; }
        await api('POST', `/projects/${pid}/versions/${cur().buildId}/approve`, { approvedBy: name.value.trim() });
        S.dialog = null;
        await reload();
        drawLayer();
        toast(`Version ${cur().versionNo} approved. Ready to show.`);
      } catch (err) { fail(err); go_.disabled = false; }
    } }, dirty() ? `Save and approve version ${no}` : `Approve version ${no}`);
    return scrim(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' },
      h('h2', { id: 'dlg-t', text: `Approve version ${no}?` }),
      h('p', { class: 'lead', text: 'This marks it ready to show the business owner. It doesn’t publish anything; no website goes live. Only a person can approve.' }),
      h('ul', { class: 'checks' }, checks),
      items.length ? h('p', { class: 'hint', text: 'You can approve anyway; anything missing is left off the site.' }) : null,
      c.approveBlocker ? h('div', { class: 'note error', style: 'margin-top:12px', text: c.approveBlocker }) : null,
      h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Approving as'), name),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: closeDialog }, 'Cancel'), go_)));
  }

  function showDialog() {
    const c = cur();
    const links = S.view.links.filter((l) => l.versionNo === c.versionNo);
    const active = S.showUrl || links.find((l) => l.state === 'ACTIVE' && l.url)?.url || null;
    const abs = (u) => new URL(u, location.href).href;
    let body;
    if (c.status === 'APPROVED') {
      body = [
        c.showBlocker ? h('div', { class: 'note amber', style: 'margin-top:16px' }, c.showBlocker,
          c.document.cta.action.kind === 'unset' ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: () => { closeDialog(); openSettings(); } }, 'Add the destination')) : null) : null,
        h('button', { class: 'btn dark block lg', style: 'margin-top:18px', disabled: Boolean(c.showBlocker), onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await api('POST', `/projects/${pid}/versions/${c.buildId}/show`);
            S.showUrl = r.url;
            await reload();
            drawLayer();
          } catch (err) { fail(err); btn.disabled = false; }
        } }, 'Create private link'),
      ];
    } else {
      const input = h('input', { type: 'text', readonly: true, value: active ? abs(active) : '', placeholder: 'No active link', 'aria-label': 'Private link', onfocus: (e) => e.target.select() });
      body = [
        h('div', { class: 'linkrow' }, input, h('button', { class: 'btn dark', disabled: !active, onclick: async () => {
          try { await navigator.clipboard.writeText(abs(active)); toast('Link copied'); } catch { input.focus(); toast('Select the link and copy it'); }
        } }, 'Copy link')),
        h('button', { class: 'btn block lg', style: 'margin-top:10px', disabled: !active, onclick: () => window.open(abs(active), '_blank', 'noopener') }, 'Present full screen'),
        h('div', { class: 'links' }, links.map((l) => h('div', { class: 'lk' },
          h('span', { class: `badge ${l.state === 'ACTIVE' ? 'sage' : l.state === 'REVOKED' ? 'error' : ''}`, text: LINK_STATE[l.state] }),
          h('span', { class: 'grow muted', text: l.state === 'REVOKED' ? `Revoked ${date(l.revokedAt)}` : `${l.state === 'ACTIVE' ? 'Works until' : 'Ended'} ${date(l.expiresAt)}` }),
          l.state === 'ACTIVE' ? h('button', { class: 'btn sm danger', onclick: async () => {
            if (!confirm('Revoke this link? Anyone who has it will no longer be able to open the preview. The version itself does not change.')) return;
            try {
              await api('POST', `/projects/${pid}/links/${l.linkId}/revoke`, { revokedBy: remember('scopely.approver') || 'seller' });
              if (S.showUrl === l.url) S.showUrl = null;
              await reload('Link revoked'); drawLayer();
            } catch (err) { fail(err); }
          } }, 'Revoke') : null))),
        h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: async () => {
          try { const r = await api('POST', `/projects/${pid}/versions/${c.buildId}/link`, { kind: 'show' }); S.showUrl = r.url; await reload('New link ready'); drawLayer(); } catch (err) { fail(err); }
        } }, 'New link'),
      ];
    }
    return scrim(h('div', { class: 'dialog wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' },
      h('h2', { id: 'dlg-t', text: `Show ${business} their website` }),
      h('p', { class: 'lead', text: `Share a private preview of version ${c.versionNo}. It isn’t a live website and search engines can’t find it.` }),
      body,
      h('div', { class: 'next' }, h('span', { text: 'Each link works for 72 hours unless you revoke it sooner.' }), h('button', { class: 'btn sm', onclick: closeDialog }, 'Done'))));
  }

  // ---------------------------------------------------------------- keyboard: Esc closes the innermost thing first
  onEscape = () => {
    if (!document.body.contains($panel)) return false;
    if (S.upload || S.picker) { S.upload = null; S.picker = null; drawInspector(); return true; }
    if (S.popover) { S.popover = false; drawLayer(); $head.querySelector('.verbtn')?.focus(); return true; }
    if (S.dialog) { closeDialog(); return true; }
    if (S.drawer) { S.drawer = false; drawDrawer(); drawToolbar(); return true; }
    if (S.selected) { select(null); return true; }
    if (S.preview) { setPreview(false); return true; }
    if (S.sheet) { S.sheet = false; drawSheets(); return true; }
    return false;
  };
  const onKey = (e) => {
    if (!document.body.contains($panel)) { window.removeEventListener('keydown', onKey); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (mod && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); undoUnsaved(); }
  };
  window.addEventListener('keydown', onKey);

  function drawAll() { drawHead(); drawToolbar(); drawPanel(); drawInspector(); drawDrawer(); }
  drawAll();
  showPreview(cur().html);
}

// ------------------------------------------------------------------ fix builder (Slice 7)
//
// One observed broken contact link, repaired on a copy of the captured page with a destination a
// person typed and confirmed. PROBLEM → PROOF → FIX → BEFORE/AFTER → CONFIRM → SHOW, top to bottom.
// Nothing here edits a website: the server captures, corrects and gates; this page only asks.

const FIX_STEPS = [['problem', 'Problem'], ['proof', 'Proof'], ['fix', 'Fix'], ['beforeAfter', 'Before / After'], ['confirm', 'Confirm'], ['show', 'Show']];
const CHANNEL_WORD = { phone: 'Phone number', whatsapp: 'WhatsApp number', email: 'Email address' };
const CHANNEL_HINT = {
  phone: 'With the country code, for example +44 20 7946 0000.',
  whatsapp: 'The WhatsApp number with its country code, for example +44 7700 900123.',
  email: 'For example bookings@clinic.co.uk.',
};

async function fixView(pid) {
  document.title = 'Scopely · Fix';
  const main = h('main', { class: 'page fixpage' }, h('div', { class: 'card skeleton', style: 'height:120px' }));
  $app.replaceChildren(appbar({ href: '#/', label: 'Back to opportunities' }), main);
  const F = { w: null, edit: null, editFor: null, showUrl: null, split: 50 };
  const toCaseFile = () => $app.replaceChildren(appbar({ href: `#/o/${F.w.project.opportunityId}`, label: 'Back to case file' }), main);

  async function load() {
    F.w = await api('GET', `/fix/${pid}`);
    const c = F.w.current;
    if (c && F.editFor !== c.buildId) {
      try { F.edit = await api('POST', `/fix/${pid}/versions/${c.buildId}/link`, { kind: 'edit' }); F.editFor = c.buildId; } catch { F.edit = null; }
    }
  }
  try { await load(); } catch (err) {
    main.replaceChildren(h('div', { class: 'card empty' }, h('h2', { text: 'This fix could not be opened' }), h('p', { class: 'muted', text: err.message }),
      h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: () => route(), text: 'Try again' }))));
    return;
  }
  document.title = `Scopely · Fix · ${F.w.business.name}`;
  toCaseFile();

  const stepState = (key) => key === 'proof' ? (F.w.steps.capture === 'done' ? 'done' : 'current') : F.w.steps[key];
  const section = (key, n, title, ...kids) => h('section', { class: `card fixstep ${stepState(key)}`, 'aria-labelledby': `fx-${key}` },
    h('div', { class: 'fxhead' }, h('span', { class: 'fxnum', text: stepState(key) === 'done' ? '✓' : String(n) }), h('h2', { id: `fx-${key}`, text: title })), ...kids);

  function draw() {
    const w = F.w;
    const e = w.focus;
    main.replaceChildren(
      h('div', { class: 'eyebrow fx', text: 'Fix · Website Fix Sprint' }),
      h('h1', { style: 'margin-top:10px', text: `Fix ${w.business.name}’s contact link` }),
      h('p', { class: 'muted', style: 'margin-top:8px;max-width:640px', text: 'Scopely corrects only the broken destination, on a copy of the page it captured, with the value you type and confirm. The business’s live website is never touched.' }),
      h('ol', { class: 'fxsteps', 'aria-label': 'Progress' }, FIX_STEPS.map(([k, label]) => h('li', { class: stepState(k) }, h('i'), label))),
      ...(e ? [problem(e), proof(e), fix(e), beforeAfter(), confirmStep(), showStep()] : [h('div', { class: 'card empty', style: 'margin-top:20px' }, h('h2', { text: 'No broken contact link to fix' }),
          h('p', { class: 'muted', text: 'This opportunity has no observed broken contact link that still holds.' }))]));
  }

  function problem(e) {
    return section('problem', 1, 'Problem',
      h('p', { class: 'fxissue', text: e.plainIssue }),
      h('div', { class: 'fxmeta' },
        h('span', { class: 'badge blue', text: claimWord[e.claimState] }), h('span', { class: 'badge', text: confidenceWord[e.confidence] }),
        h('span', { text: `Observed ${date(e.observedAt)}` }),
        e.recheck ? h('span', { text: `Re-checked ${date(e.recheck.at)}: ${e.recheck.result}` }) : h('span', { text: 'Not re-checked yet' })));
  }

  function proof(e) {
    const c = F.w.capture;
    const kids = [
      h('div', { class: 'label', text: 'Evidence' }),
      h('div', { class: 'fxquote mono', text: e.quote }),
      h('div', { class: 'fxmeta' }, h('span', { class: 'mono', text: e.url }), e.observedHref ? h('span', {}, 'Link opens ', h('s', { class: 'mono', text: e.observedHref })) : null),
    ];
    if (c) {
      kids.push(h('div', { class: 'note sage', style: 'margin-top:14px' },
        h('b', { text: 'Page captured. ' }), `A copy of ${c.finalUrl} was saved ${when(c.capturedAt)}. `,
        c.hrefOccurrences ? `${plural(c.hrefOccurrences, 'link on it still opens', 'links on it still open')} the broken destination.` : 'No link on it opens the broken destination any more.'),
        h('p', { class: 'hint', text: 'The capture is proof of what the page showed. The finding above is what Scopely acts on.' }));
      if (!c.hrefOccurrences) kids.push(h('div', { class: 'note amber', style: 'margin-top:10px', text: 'There is nothing to fix on this copy. The page may already have been corrected.' }));
      kids.push(h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: (ev) => capture(ev.currentTarget) }, 'Capture again'));
    } else {
      kids.push(h('div', { class: 'note', style: 'margin-top:14px', id: 'fx-capturing' }, 'Capturing a copy of the page…'));
    }
    return section('proof', 2, 'Proof', kids);
  }

  async function capture(btn) {
    if (btn) btn.disabled = true;
    try {
      await api('POST', `/fix/${pid}/capture`, { evidenceId: F.w.focus.evidenceId });
      await load(); draw(); toast('Page captured');
    } catch (err) {
      if (btn) { btn.disabled = false; fail(err); return; }
      const slot = document.getElementById('fx-capturing');
      if (slot) slot.replaceWith(h('div', { class: 'note error', style: 'margin-top:14px' }, err.message,
        h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', onclick: (ev) => { ev.currentTarget.closest('.note').replaceWith(h('div', { class: 'note', style: 'margin-top:14px', id: 'fx-capturing' }, 'Capturing a copy of the page…')); capture(); } }, 'Try again'))));
    }
  }

  function fix(e) {
    const w = F.w;
    const cor = w.correction;
    const canFix = Boolean(w.capture && w.capture.hrefOccurrences);
    const channels = e.channels;
    let channel = cor && channels.includes(cor.channel) ? cor.channel : channels[0];
    const sel = h('select', { 'aria-label': 'Kind of destination', disabled: !canFix, onchange: () => { channel = sel.value; hint.textContent = CHANNEL_HINT[channel]; } },
      channels.map((c) => h('option', { value: c, selected: c === channel }, CHANNEL_WORD[c])));
    const input = h('input', { type: 'text', placeholder: channel === 'email' ? 'name@business.com' : '+44 …', maxlength: 200, disabled: !canFix, autocomplete: 'off',
      value: cor ? cor.correctedHref.replace(/^tel:|^mailto:|^https:\/\/wa\.me\//, (m) => m === 'https://wa.me/' ? '+' : '') : '' });
    const hint = h('p', { class: 'hint', text: CHANNEL_HINT[channel] });
    const save = h('button', { class: 'btn', disabled: !canFix, onclick: async () => {
      if (!input.value.trim()) { input.focus(); return; }
      save.disabled = true;
      try { await api('POST', `/fix/${pid}/corrections`, { evidenceId: e.evidenceId, channel, value: input.value }); await load(); draw(); toast('Destination saved'); }
      catch (err) { fail(err); save.disabled = false; }
    } }, cor ? 'Change destination' : 'Use this destination');
    return section('fix', 3, 'Fix',
      h('p', { class: 'muted', text: 'Type where this link should go, as the business confirmed it. Scopely never guesses a destination.' }),
      h('div', { class: 'fxform' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Kind'), sel),
        h('label', { class: 'field grow' }, h('span', { class: 'lab' }, 'Correct destination'), input),
        save),
      hint,
      cor ? h('div', { class: 'fxreads' }, h('span', { class: 'label', text: 'Proposed' }), h('span', { text: cor.reads }), h('span', { class: 'mono muted', text: cor.correctedHref }),
        cor.confirmedAt ? h('span', { class: 'badge sage', text: `Confirmed by ${cor.confirmedBy}` }) : h('span', { class: 'badge amber', text: 'Not confirmed' })) : null);
  }

  function building() {
    const steps = ['Reading the captured page', 'Correcting the link', 'Preparing before and after'];
    const items = steps.map((s) => h('li', {}, h('i'), s));
    const fill = h('i');
    const el = h('div', { class: 'veil' }, h('div', { class: 'gencard', role: 'status', 'aria-live': 'polite' },
      h('h2', { text: 'Building the fix on a copy of the page…' }), h('p', { class: 'sub', text: `${F.w.business.name} · a private draft` }),
      h('div', { class: 'bar' }, fill), h('ol', { class: 'steps' }, items),
      h('p', { class: 'fine', text: 'Only the link’s destination changes. Nothing on the live website is touched.' })));
    document.body.append(el);
    let i = 0;
    const mark = () => { items.forEach((li, j) => { li.className = j < i ? 'done' : j === i ? 'on' : ''; }); fill.style.width = `${Math.max(8, (i / steps.length) * 100)}%`; };
    mark();
    const timer = setInterval(() => { if (i < steps.length - 1) { i++; mark(); } }, 600);
    return { async done() { clearInterval(timer); i = steps.length; mark(); await new Promise((r) => setTimeout(r, 300)); el.remove(); }, stop() { clearInterval(timer); el.remove(); } };
  }

  async function generate(btn) {
    btn.disabled = true;
    const b = building();
    try {
      const r = await api('POST', `/fix/${pid}/generate`);
      if (r.status !== 'SUCCEEDED') { b.stop(); toast(r.message || 'The fix could not be built. Nothing was saved.', { bad: true }); btn.disabled = false; return; }
      await load(); await b.done(); draw();
      document.getElementById('fx-beforeAfter')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { b.stop(); fail(err); btn.disabled = false; }
  }

  function beforeAfter() {
    const w = F.w;
    const c = w.current;
    const ready = w.steps.beforeAfter !== 'todo';
    if (!ready) return section('beforeAfter', 4, 'Before / After', h('p', { class: 'muted', text: 'Add the correct destination to build the fix.' }));
    if (!c || c.stale) {
      return section('beforeAfter', 4, 'Before / After',
        c && c.stale ? h('div', { class: 'note amber', text: `The destination changed since version ${c.versionNo}. Build the fix again to use it.` }) : null,
        h('button', { class: 'btn primary lg', style: 'margin-top:12px', onclick: (ev) => generate(ev.currentTarget) }, 'Build the fix'));
    }
    const d = c.document;
    const cards = d.corrections.map((k) => h('div', { class: 'fxba' },
      h('div', { class: 'fxside before' }, h('header', { text: 'Before · Observed' }),
        h('div', { class: 'fxbody' }, k.context?.before ? h('p', { class: 'ctx', text: k.context.before }) : null,
          h('span', { class: 'fxlnk', text: k.label || 'Contact link' }), h('p', { class: 'opens' }, 'Opens ', h('s', { text: k.observedHref })))),
      h('div', { class: 'fxside after' }, h('header', { text: 'After · Proposed' }),
        h('div', { class: 'fxbody' }, k.context?.before ? h('p', { class: 'ctx', text: k.context.before }) : null,
          h('span', { class: 'fxlnk', text: k.label || 'Contact link' }), h('p', { class: 'opens' }, 'Opens ', h('b', { text: k.correctedHref })),
          h('p', { class: 'small', text: `${c.corrections.find((x) => x.correctionId === k.correctionId)?.reads ?? ''}.` })))));
    const n = d.corrections.reduce((s, k) => s + k.replaced, 0);
    const kids = [
      h('p', { class: 'muted', text: `Version ${c.versionNo}. ${n === 1 ? 'One link was' : `${n} links were`} corrected on the copy. Everything else on the page is unchanged.` }),
      cards,
    ];
    if (F.edit) {
      const after = h('iframe', { class: 'after', src: F.edit.after, title: 'After: the corrected copy', sandbox: '', loading: 'lazy', scrolling: 'no', tabindex: '-1' });
      const before = h('iframe', { class: 'before', src: F.edit.before, title: 'Before: the page as captured', sandbox: '', loading: 'lazy', scrolling: 'no', tabindex: '-1' });
      const handle = h('div', { class: 'fxhandle' });
      const stage = h('div', { class: 'fxstage' }, h('div', { class: 'fxscroll' }, h('div', { class: 'fxlayers' }, before, after)), handle,
        h('span', { class: 'fxtag l', text: 'Before · Observed' }), h('span', { class: 'fxtag r', text: 'After · Proposed' }));
      const range = h('input', { type: 'range', min: 0, max: 100, value: F.split, 'aria-label': 'Compare before and after', class: 'fxrange' });
      const place = () => { after.style.clipPath = `inset(0 0 0 ${F.split}%)`; handle.style.left = `${F.split}%`; };
      range.addEventListener('input', () => { F.split = Number(range.value); place(); });
      place();
      kids.push(h('details', { class: 'fxwhole' }, h('summary', { text: 'Compare the whole page' }),
        h('p', { class: 'hint', text: 'Both copies are shown without scripts or outside images, so they may look plainer than the live page.' }), stage, range));
    }
    return section('beforeAfter', 4, 'Before / After', kids);
  }

  function confirmStep() {
    const w = F.w;
    const c = w.current;
    if (!c || c.stale) return section('confirm', 5, 'Confirm', h('p', { class: 'muted', text: 'Build the fix, then confirm the corrected destination.' }));
    if (c.approvedAt) {
      return section('confirm', 5, 'Confirm', h('div', { class: 'note sage' }, `Confirmed and approved by ${c.approvedBy} ${when(c.approvedAt)}. `,
        c.corrections.map((k) => k.reads).join('; '), '.'));
    }
    const k = c.corrections[0];
    const tick = h('input', { type: 'checkbox', id: 'fx-tick' });
    const name = h('input', { type: 'text', value: remember('scopely.approver'), placeholder: 'Your name', maxlength: 120, autocomplete: 'name' });
    const btn = h('button', { class: 'btn primary', onclick: async () => {
      if (!tick.checked) { tick.focus(); toast('Tick the box to confirm the destination.', { bad: true }); return; }
      if (!name.value.trim()) { name.focus(); return; }
      remember('scopely.approver', name.value.trim());
      btn.disabled = true;
      try { await api('POST', `/fix/${pid}/versions/${c.buildId}/confirm`, { confirmedBy: name.value.trim(), confirmed: true }); await load(); draw(); toast(`Version ${c.versionNo} confirmed. Ready to show.`); }
      catch (err) { fail(err); btn.disabled = false; }
    } }, 'Confirm and approve');
    return section('confirm', 5, 'Confirm',
      h('label', { class: 'fxtick', for: 'fx-tick' }, tick,
        h('span', {}, `I confirm that ${k ? k.correctedHref : 'this destination'} is the correct destination for ${w.business.name}. `,
          h('span', { class: 'muted', text: k ? `${k.reads}.` : '' }))),
      c.approveBlocker && !/confirm/i.test(c.approveBlocker) ? h('div', { class: 'note error', style: 'margin-top:12px', text: c.approveBlocker }) : null,
      h('div', { class: 'fxform', style: 'margin-top:14px' }, h('label', { class: 'field grow' }, h('span', { class: 'lab' }, 'Confirming as'), name), btn),
      h('p', { class: 'hint', text: 'Only a person can confirm. Nothing can be shown to the business until you do.' }));
  }

  function showStep() {
    const w = F.w;
    const c = w.current;
    if (!c || c.stale || !c.approvedAt) return section('show', 6, 'Show', h('p', { class: 'muted', text: 'Once confirmed, share a private preview with the business owner.' }));
    const links = (w.links || []).filter((l) => l.versionNo === c.versionNo);
    const active = F.showUrl || links.find((l) => l.state === 'ACTIVE' && l.url)?.url || null;
    const abs = (u) => new URL(u, location.href).href;
    const kids = [h('p', { class: 'muted', text: 'A private preview of the fix. It isn’t a live website and search engines can’t find it. Each link works for 72 hours unless you revoke it sooner.' })];
    if (c.status === 'APPROVED') {
      if (c.showBlocker) kids.push(h('div', { class: 'note amber', style: 'margin-top:12px', text: c.showBlocker }));
      kids.push(h('button', { class: 'btn dark lg', style: 'margin-top:14px', disabled: Boolean(c.showBlocker), onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true;
        try { const r = await api('POST', `/fix/${pid}/versions/${c.buildId}/show`); F.showUrl = r.url; await load(); draw(); toast('Private link ready'); }
        catch (err) { fail(err); b.disabled = false; }
      } }, 'Create private link'));
    } else {
      const input = h('input', { type: 'text', readonly: true, value: active ? abs(active) : '', placeholder: 'No active link', 'aria-label': 'Private link', onfocus: (ev) => ev.target.select() });
      kids.push(h('div', { class: 'linkrow' }, input,
        h('button', { class: 'btn dark', disabled: !active, onclick: async () => { try { await navigator.clipboard.writeText(abs(active)); toast('Link copied'); } catch { input.focus(); toast('Select the link and copy it'); } } }, 'Copy link'),
        h('button', { class: 'btn', disabled: !active, onclick: () => window.open(abs(active), '_blank', 'noopener') }, 'Open')));
      kids.push(h('div', { class: 'links' }, links.map((l) => h('div', { class: 'lk' },
        h('span', { class: `badge ${l.state === 'ACTIVE' ? 'sage' : l.state === 'REVOKED' ? 'error' : ''}`, text: LINK_STATE[l.state] }),
        h('span', { class: 'grow muted', text: l.state === 'REVOKED' ? `Revoked ${date(l.revokedAt)}` : `${l.state === 'ACTIVE' ? 'Works until' : 'Ended'} ${date(l.expiresAt)}` }),
        l.state === 'ACTIVE' ? h('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm('Revoke this link? Anyone who has it will no longer be able to open the preview. The version itself does not change.')) return;
          try { await api('POST', `/fix/${pid}/links/${l.linkId}/revoke`, { revokedBy: remember('scopely.approver') || 'seller' }); if (F.showUrl === l.url) F.showUrl = null; await load(); draw(); toast('Link revoked'); }
          catch (err) { fail(err); }
        } }, 'Revoke') : null))));
      kids.push(h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: async () => {
        try { const r = await api('POST', `/fix/${pid}/versions/${c.buildId}/link`, { kind: 'show' }); F.showUrl = r.url; await load(); draw(); toast('New link ready'); } catch (err) { fail(err); }
      } }, 'New link'));
    }
    return section('show', 6, 'Show', kids);
  }

  draw();
  if (F.w.focus && !F.w.capture) capture();
}

route();
