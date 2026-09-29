// The Scopely product shell (Slice 8): the top bar with the stage navigation, the filter bar, the
// map's place (deferred, U3), the opportunity feed and the Case File. Built to the approved
// dashboard design; every value on screen comes from the server, and stages and build/sell
// states are the server's, never worked out here.
//
// Routes (hash, under /app):
//   #/                 Discover: every opportunity
//   #/stage/<key>      one stage: opportunities, build, sell, deliver, verify
//   #/o/<id>           the Case File of one opportunity
// The builders keep their own routes (#/p/…, #/f/…) and open unchanged.
import { $app, api, fail, go, h, money } from './lib.js';
import { mountMapSlot } from './map-slot.js';
import { renderCaseFile } from './case-file.js';

export const STAGES = [
  { key: 'discover', label: 'Discover', sub: 'Every opportunity Scopely found' },
  { key: 'opportunities', label: 'Opportunities', stage: 'OPPORTUNITIES', sub: 'Ready to review and build' },
  { key: 'build', label: 'Build', stage: 'BUILD', sub: 'Built, not yet pitched' },
  { key: 'sell', label: 'Sell', stage: 'SELL', sub: 'Pitched, replied or closed' },
  { key: 'deliver', label: 'Deliver', stage: 'DELIVER', planned: true, sub: 'Won work to deliver' },
  { key: 'verify', label: 'Verify', stage: 'VERIFY', planned: true, sub: 'Rechecked after delivery' },
];

const WEBSITE_STATUS = {
  WEBSITE_NOT_OBSERVED: 'not observed', WEBSITE_PRESENT: 'found', WEBSITE_UNREACHABLE: 'unreachable', WEBSITE_NEEDS_REVIEW: 'needs review', UNKNOWN: 'not checked',
};
const SELL_WORD = { DRAFTED: 'Pitch drafted', APPROVED: 'Pitch approved', SENT: 'Pitch sent', PITCHED: 'Pitched', REPLIED: 'Replied', WON: 'Won', LOST: 'Lost' };
const BUILD_WORD = { DEMO_DRAFT: 'Draft built', DEMO_APPROVED: 'Approved', DEMO_SHOWN: 'Shown to owner', DELIVERY_DRAFT: 'Delivery draft', DELIVERY_APPROVED: 'Delivery approved', DELIVERY_SHOWN: 'Delivery shown' };

// The shell's own state survives route changes, so opening a Case File keeps the stage and filters.
const S = { stage: 'discover', f: { path: 'all', vertical: 'all', city: 'all' }, items: null, workspace: null, open: null, hov: null };
let mounted = null;

const pathOf = (o) => (o.path === 'WEBSITE' ? 'web' : o.path === 'FIX' ? 'fix' : 'other');
const stageDef = () => STAGES.find((s) => s.key === S.stage) ?? STAGES[0];
const inStage = (o, def = stageDef()) => !def.stage || o.stage === def.stage;
const matches = (o) => (S.f.path === 'all' || pathOf(o) === S.f.path)
  && (S.f.vertical === 'all' || o.vertical === S.f.vertical) && (S.f.city === 'all' || o.city === S.f.city);

export function stageHash(key) { return key === 'discover' ? '#/' : `#/stage/${key}`; }

export async function shellView(hash, ctx) {
  let m;
  let caseId = null;
  if ((m = hash.match(/^#\/o\/(\d+)$/))) caseId = m[1];
  else if ((m = hash.match(/^#\/stage\/([a-z]+)$/)) && STAGES.some((s) => s.key === m[1])) S.stage = m[1];
  else S.stage = 'discover';
  if (!mounted || !mounted.root.isConnected) mounted = mount();
  ctx.setEscape(() => { if (!S.open) return false; go(stageHash(S.stage)); return true; });
  S.open = caseId;
  mounted.root.classList.toggle('casing', Boolean(caseId));
  document.title = caseId ? 'Scopely · Case file' : `Scopely · ${stageDef().label}`;
  await loadFeed();
  if (caseId) await openCase(caseId);
  else { mounted.caseView.replaceChildren(); mounted.feedView.hidden = false; mounted.caseView.hidden = true; drawFeed(); }
  mounted.map.select(caseId);
}

function mount() {
  const stages = h('nav', { class: 'sh-stages', 'aria-label': 'Stages' });
  const stageSel = h('select', { class: 'sh-stagesel', 'aria-label': 'Stage', onchange: (e) => go(stageHash(e.target.value)) });
  const ws = h('span', { class: 'sh-ws' });
  const top = h('header', { class: 'sh-top' },
    h('a', { class: 'logo', href: '#/' }, h('i'), 'SCOPELY'), stages, stageSel, h('div', { class: 'sh-topr' }, ws));
  const filters = h('div', { class: 'sh-filters', role: 'group', 'aria-label': 'Filters' });
  const mapEl = h('div', { class: 'sh-map' });
  const stage = h('section', { class: 'sh-stage', 'aria-label': 'Map' }, mapEl, filters);
  const feedTitle = h('h2');
  const feedSub = h('p');
  const split = h('div', { class: 'split' });
  const planned = h('div');
  const feed = h('div', { class: 'feed', role: 'list' });
  const feedView = h('div', { class: 'sh-feedview' }, h('div', { class: 'pHead' }, h('div', {}, feedTitle, feedSub), split),
    h('div', { class: 'scroll' }, planned, feed));
  const caseView = h('div', { class: 'sh-caseview', hidden: true });
  const panel = h('aside', { class: 'sh-panel', 'aria-label': 'Opportunities' }, feedView, caseView);
  const root = h('div', { class: 'shell' }, top, h('div', { class: 'sh-body' }, stage, panel));
  $app.replaceChildren(root);
  const map = mountMapSlot(mapEl);
  map.onSelect = (id) => go(`#/o/${id}`);
  return { root, stages, stageSel, ws, filters, map, feedTitle, feedSub, split, planned, feed, feedView, caseView, panel };
}

async function loadFeed() {
  const [items, workspace] = await Promise.all([
    api('GET', '/opportunities').catch((err) => ({ error: err.message })),
    S.workspace ? Promise.resolve(S.workspace) : api('GET', '/workspace').catch(() => null),
  ]);
  S.workspace = workspace;
  S.items = items;
  const u = mounted;
  u.ws.replaceChildren(workspace ? h('span', { text: workspace.name }) : null,
    h('span', { class: 'sh-auth', title: 'Sign-in is not built yet. This server acts in one workspace.', text: 'Not signed in' }));
  drawStages();
  drawFilters();
}

function drawStages() {
  const list = Array.isArray(S.items) ? S.items : [];
  const current = S.open ? null : S.stage;
  mounted.stages.replaceChildren(...STAGES.map((s) => {
    const n = s.stage ? list.filter((o) => inStage(o, s)).length : null;
    return h('a', { href: stageHash(s.key), 'aria-current': String(current === s.key) }, s.label,
      s.planned ? h('span', { class: 'plan', text: 'PLANNED' }) : n ? h('span', { class: 'n', text: String(n) }) : null);
  }));
  mounted.stageSel.replaceChildren(...STAGES.map((s) => h('option', { value: s.key, selected: S.stage === s.key }, `${s.label}${s.planned ? ' (planned)' : ''}`)));
}

function drawFilters() {
  const list = Array.isArray(S.items) ? S.items : [];
  const opts = (key) => [...new Set(list.map((o) => o[key]).filter(Boolean))].sort();
  const select = (label, key, all, values) => h('label', { class: 'fl' }, h('span', { text: label }),
    h('select', { onchange: (e) => { S.f[key] = e.target.value; drawFeed(); } },
      h('option', { value: 'all', selected: S.f[key] === 'all' }, all), values.map((v) => h('option', { value: v, selected: S.f[key] === v }, v))));
  const seg = h('div', { class: 'seg sh-seg', role: 'group', 'aria-label': 'Opportunity type' },
    [['all', 'All', null], ['web', 'Needs a website', 'web'], ['fix', 'Needs a fix', 'fix']].map(([v, label, dot]) =>
      h('button', { 'aria-pressed': String(S.f.path === v), onclick: () => { S.f.path = v; drawFilters(); drawFeed(); } }, dot ? h('i', { class: `dot ${dot}` }) : null, label)));
  mounted.filters.replaceChildren(select('Location', 'city', 'All locations', opts('city')), select('Industry', 'vertical', 'All industries', opts('vertical')), seg);
}

function drawFeed() {
  const u = mounted;
  const def = stageDef();
  if (!Array.isArray(S.items)) {
    u.feedTitle.textContent = def.label;
    u.feedSub.textContent = '';
    u.split.replaceChildren();
    u.feed.replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Opportunities could not be loaded' }), S.items?.error ?? '',
      h('p', {}, h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => shellView(location.hash || '#/', { setEscape: () => undefined }) }, 'Try again'))));
    return;
  }
  const list = S.items.filter((o) => matches(o) && inStage(o));
  u.feedTitle.textContent = def.key === 'discover' ? 'Opportunities found' : def.label;
  u.feedSub.textContent = def.sub;
  const web = list.filter((o) => o.path === 'WEBSITE').length;
  const fix = list.filter((o) => o.path === 'FIX').length;
  u.split.replaceChildren(h('div', {}, h('span', {}, h('i', { class: 'dot web' }), 'Need a website'), h('b', { text: String(web) })),
    h('div', {}, h('span', {}, h('i', { class: 'dot fix' }), 'Need a fix'), h('b', { text: String(fix) })));
  u.planned.replaceChildren(def.planned ? h('div', { class: 'planned' }, h('b', { text: `${def.label} is planned` }),
    def.key === 'deliver' ? 'Won work is listed here. Scopely does not track delivery yet.' : 'Scopely will re-check the original evidence after delivery. Nothing is verified yet.') : '');
  u.feed.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty' }, h('b', { text: 'Nothing here yet' }),
    S.items.length === 0 ? 'When a search finds a business with an observed problem you can sell a fix for, it appears here.'
      : def.key === 'discover' ? 'No opportunities match these filters.' : `Opportunities appear here as you move them to ${def.label.toLowerCase()}.`)]));
  u.map.update(list);
}

/** The steps of each path, so a website and a fix never read as the same thing. */
function flow(o) {
  if (o.path === 'WEBSITE') {
    const built = o.buildState !== 'NONE';
    return [['Opportunity', 'done'], ['Build website', built ? 'done' : 'cur']];
  }
  const built = o.buildState !== 'NONE';
  return [['Observed problem', 'done'], ['Prove', o.captured || built ? 'done' : 'cur'], ['Build fix', built ? 'done' : o.captured ? 'cur' : '']];
}

function card(o) {
  const web = o.path === 'WEBSITE';
  const status = o.sellState !== 'NOT_STARTED' ? SELL_WORD[o.sellState] : BUILD_WORD[o.buildState] ?? null;
  const badge = web ? h('span', { class: 'badge b-web', text: 'WEBSITE OPPORTUNITY' }) : o.path === 'FIX' ? h('span', { class: 'badge b-fix', text: 'FIX OPPORTUNITY' }) : null;
  const head = h('div', { class: 'cBiz' }, h('span', { text: o.business }), h('span', { text: o.city ?? '' }));
  const foot = h('div', { class: 'cFoot' }, h('span', { text: o.service ?? 'No service mapped' }), h('b', { text: o.service ? money(o.currency, o.price) : '' }));
  const steps = h('ol', { class: 'flow', 'aria-label': web ? 'Website path' : 'Fix path' }, flow(o).map(([label, st]) => h('li', { class: st }, label)));
  const open = () => go(`#/o/${o.opportunityId}`);
  let body;
  if (web) {
    body = [
      h('div', { class: 'lst' }, h('div', {},
        h('b', { text: o.business }),
        h('span', { text: [o.vertical, o.rating !== null && o.reviewCount !== null ? `${Number(o.rating)} ★ (${o.reviewCount})` : null].filter(Boolean).join(' · ') || 'Listing details not known' }),
        h('span', {}, 'Website ', h('em', { text: WEBSITE_STATUS[o.websiteStatus] ?? 'not checked' })))),
      h('div', { class: 'cBody' }, h('div', { class: 'row' }, badge, status ? h('span', { class: 'chip', text: status }) : null),
        h('div', { class: 'cOpp', text: o.issue ?? 'Needs a website' }), steps, foot,
        o.buildable && !o.projectId ? h('button', { class: 'cAct web', onclick: (e) => { e.stopPropagation(); startBuild(o, e.currentTarget); } }, 'Build website') : null),
    ];
  } else {
    body = [h('div', { class: 'cBody' }, h('div', { class: 'row' }, badge, status ? h('span', { class: 'chip', text: status }) : null), head,
      h('div', { class: 'cOpp', text: o.issue ?? 'Observed problem' }),
      o.observed ? h('div', { class: 'quote' }, h('span', { class: 'eyebrow', text: 'Observed' }), h('span', { text: o.observed.text || o.observed.url })) : null,
      steps, foot)];
  }
  const el = h('article', { class: `card ${web ? 'web' : 'fix'}${S.open === o.opportunityId ? ' sel' : ''}`, role: 'listitem', tabindex: '0',
    'aria-label': `${o.business}: ${o.issue ?? ''}`, 'data-id': o.opportunityId,
    onclick: open, onkeydown: (e) => { if (e.key === 'Enter' && e.target === el) open(); },
    onmouseenter: () => mounted.map.highlight(o.opportunityId), onmouseleave: () => mounted.map.highlight(null) }, body);
  return el;
}

async function startBuild(o, btn) {
  btn.disabled = true;
  try { const r = await api('POST', `/opportunities/${o.opportunityId}/website`); go(`#/p/${r.projectId}/setup`); }
  catch (err) { btn.disabled = false; fail(err); }
}

async function openCase(id) {
  const u = mounted;
  u.feedView.hidden = true;
  u.caseView.hidden = false;
  if (!u.caseView.firstChild || u.caseView.dataset.id !== id) {
    u.caseView.dataset.id = id;
    u.caseView.replaceChildren(h('div', { class: 'cHead' }, h('a', { class: 'back', href: stageHash(S.stage) }, '← Back'), h('span', { class: 'eyebrow', text: 'Case file' })),
      h('div', { class: 'sec' }, h('div', { class: 'skeleton', style: 'height:28px;width:60%' }), h('div', { class: 'skeleton', style: 'height:120px' })));
  }
  let cf;
  try { cf = await api('GET', `/opportunities/${id}`); } catch (err) {
    u.caseView.replaceChildren(h('div', { class: 'cHead' }, h('a', { class: 'back', href: stageHash(S.stage) }, '← Back'), h('span', { class: 'eyebrow', text: 'Case file' })),
      h('div', { class: 'empty' }, h('b', { text: err.status === 404 ? 'This opportunity does not exist' : 'This case file could not be opened' }), err.message));
    return;
  }
  if (S.open !== id) return; // the seller moved on while it loaded
  document.title = `Scopely · ${cf.business.name}`;
  const scroll = u.caseView.querySelector('.scroll');
  const y = scroll && u.caseView.dataset.loaded === id ? scroll.scrollTop : 0;
  u.caseView.replaceChildren(renderCaseFile(cf, { back: stageHash(S.stage), reload: async () => { await loadFeed(); await openCase(id); } }));
  u.caseView.dataset.loaded = id;
  const next = u.caseView.querySelector('.scroll');
  if (next) next.scrollTop = y;
}
