// The Scopely product shell (Slice 8, launch pass): the top bar with the stage navigation, the
// filter bar, the opportunity map (A51), the feed and the Case File. Discover is the operating
// surface: it says where the workspace stands on FIND → QUALIFY → PRIORITISE → ANALYSE →
// OPPORTUNITY from its own counts (GET /api/discover), names the one next step, and shows every
// opportunity on the list and, where a source gave a position, on the map. Every value on screen
// comes from the server; stages and build/sell states are the server's, never worked out here.
//
// Routes (hash, under /app):
//   #/                 Discover: every opportunity
//   #/stage/<key>      one stage: opportunities, build, sell, deliver, verify
//   #/o/<id>           the Case File of one opportunity
// The builders keep their own routes (#/p/…, #/f/…) and open unchanged; Find is #/find (find.js).
import { $app, api, fail, go, h, money, plural, toast } from './lib.js';
import { mountMapSlot } from './map-slot.js';
import { renderCaseFile } from './case-file.js';
import { accountBar } from './auth.js';

export const STAGES = [
  { key: 'discover', label: 'Discover', sub: 'Every opportunity Scopely found' },
  { key: 'opportunities', label: 'Opportunities', stage: 'OPPORTUNITIES', sub: 'Ready to review and build' },
  { key: 'build', label: 'Build', stage: 'BUILD', sub: 'Built, not yet pitched' },
  { key: 'sell', label: 'Sell', stage: 'SELL', sub: 'Pitched, replied or closed' },
  { key: 'deliver', label: 'Deliver', stage: 'DELIVER', sub: 'Won work to deliver' },
  { key: 'verify', label: 'Verify', stage: 'VERIFY', sub: 'Rechecked after delivery' },
];

const WEBSITE_STATUS = {
  WEBSITE_NOT_OBSERVED: 'not observed', WEBSITE_PRESENT: 'found', WEBSITE_UNREACHABLE: 'unreachable', WEBSITE_NEEDS_REVIEW: 'needs review', UNKNOWN: 'not checked',
};
const SELL_WORD = { DRAFTED: 'Pitch drafted', APPROVED: 'Pitch approved', SENT: 'Pitch sent', PITCHED: 'Pitched', REPLIED: 'Replied', WON: 'Won', LOST: 'Lost' };
const BUILD_WORD = { DEMO_DRAFT: 'Draft built', DEMO_APPROVED: 'Approved', DEMO_SHOWN: 'Shown to owner', DELIVERY_DRAFT: 'Delivery draft', DELIVERY_APPROVED: 'Delivery approved', DELIVERY_SHOWN: 'Delivery shown' };

// The shell's own state survives route changes, so opening a Case File keeps the stage and filters.
const S = { stage: 'discover', f: { path: 'all', vertical: 'all', city: 'all', q: '', sort: 'new' }, items: null, summary: null, workspace: null, open: null, hov: null };
let mounted = null;

const pathOf = (o) => (o.path === 'WEBSITE' ? 'web' : o.path === 'FIX' ? 'fix' : 'other');
const stageDef = () => STAGES.find((s) => s.key === S.stage) ?? STAGES[0];
const inStage = (o, def = stageDef()) => !def.stage || o.stage === def.stage;
const text = (o) => [o.business, o.issue, o.city, o.vertical, o.domain, o.service].filter(Boolean).join(' ').toLowerCase();
const matches = (o) => (S.f.path === 'all' || pathOf(o) === S.f.path)
  && (S.f.vertical === 'all' || o.vertical === S.f.vertical) && (S.f.city === 'all' || o.city === S.f.city)
  && (!S.f.q || text(o).includes(S.f.q.toLowerCase()));
const CONF = { HIGH: 0, MEDIUM: 1, LOW: 2 };
/** Prioritise: newest first (the feed's own order), strongest evidence first, or highest quoted price first. */
const SORTS = {
  new: null,
  evidence: (a, b) => (CONF[a.topConfidence] ?? 3) - (CONF[b.topConfidence] ?? 3) || b.evidenceCount - a.evidenceCount,
  price: (a, b) => (b.price === null ? -1 : Number(b.price)) - (a.price === null ? -1 : Number(a.price)),
};

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
    h('a', { class: 'logo', href: '#/' }, h('i'), 'SCOPELY'), stages, stageSel,
    h('div', { class: 'sh-topr' }, h('a', { class: 'btn sm', href: '#/find' }, 'Find businesses'), ws));
  const filters = h('div', { class: 'sh-filters', role: 'group', 'aria-label': 'Filters' });
  const mapEl = h('div', { class: 'sh-map' });
  const stage = h('section', { class: 'sh-stage', 'aria-label': 'Map' }, mapEl, filters);
  const feedTitle = h('h2');
  const feedSub = h('p');
  const split = h('div', { class: 'split' });
  const planned = h('div');
  const rail = h('nav', { class: 'ds-rail', 'aria-label': 'Where you are' });
  const next = h('div', { class: 'ds-next' });
  const feed = h('div', { class: 'feed', role: 'list' });
  const feedView = h('div', { class: 'sh-feedview' }, h('div', { class: 'pHead' }, h('div', {}, feedTitle, feedSub), rail, split),
    h('div', { class: 'scroll' }, next, planned, feed));
  const caseView = h('div', { class: 'sh-caseview', hidden: true });
  const panel = h('aside', { class: 'sh-panel', 'aria-label': 'Opportunities' }, feedView, caseView);
  const root = h('div', { class: 'shell' }, top, h('div', { class: 'sh-body' }, stage, panel));
  $app.replaceChildren(root);
  const map = mountMapSlot(mapEl);
  map.onSelect = (id) => go(`#/o/${id}`);
  return { root, stages, stageSel, ws, filters, map, feedTitle, feedSub, split, planned, rail, next, feed, feedView, caseView, panel };
}

async function loadFeed() {
  if (!Array.isArray(S.items)) mounted.feed.replaceChildren(...[0, 1, 2, 3].map(() => h('div', { class: 'skeleton card-sk' })));
  const [items, workspace, summary] = await Promise.all([
    api('GET', '/opportunities').catch((err) => ({ error: err.message })),
    S.workspace ? Promise.resolve(S.workspace) : api('GET', '/workspace').catch(() => null),
    api('GET', '/discover').catch(() => null),
  ]);
  S.workspace = workspace;
  S.items = items;
  S.summary = summary;
  const u = mounted;
  u.ws.replaceChildren(...accountBar());
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
  const search = h('label', { class: 'fl fq' }, h('span', { text: 'Search' }),
    h('input', { type: 'search', value: S.f.q, placeholder: 'Business, issue, town', 'aria-label': 'Search opportunities',
      oninput: (e) => { S.f.q = e.target.value.trim(); drawFeed(); } }));
  const sort = h('label', { class: 'fl' }, h('span', { text: 'Prioritise' }),
    h('select', { onchange: (e) => { S.f.sort = e.target.value; drawFeed(); } },
      [['new', 'Newest first'], ['evidence', 'Strongest evidence'], ['price', 'Highest quote']].map(([v, l]) => h('option', { value: v, selected: S.f.sort === v }, l))));
  mounted.filters.replaceChildren(search, select('Location', 'city', 'All locations', opts('city')), select('Industry', 'vertical', 'All industries', opts('vertical')), seg, sort);
}

function drawFeed() {
  const u = mounted;
  const def = stageDef();
  u.rail.replaceChildren(...(def.key === 'discover' ? rail(S.summary) : []));
  u.rail.hidden = def.key !== 'discover' || !S.summary;
  if (!Array.isArray(S.items)) {
    u.feedTitle.textContent = def.label;
    u.feedSub.textContent = '';
    u.split.replaceChildren();
    u.next.replaceChildren();
    u.feed.replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Opportunities could not be loaded' }), S.items?.error ?? '',
      h('p', {}, h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => shellView(location.hash || '#/', { setEscape: () => undefined }) }, 'Try again'))));
    u.map.update([], { anyBusinesses: false });
    return;
  }
  const list = S.items.filter((o) => matches(o) && inStage(o));
  if (SORTS[S.f.sort]) list.sort(SORTS[S.f.sort]);
  u.feedTitle.textContent = def.key === 'discover' ? 'Opportunities' : def.label;
  const filtered = S.items.filter((o) => inStage(o)).length;
  u.feedSub.textContent = def.key === 'discover'
    ? (S.items.length ? `${list.length === S.items.length ? 'All' : `${list.length} of`} ${plural(S.items.length, 'opportunity', 'opportunities')} Scopely found` : 'Businesses with an observed problem you can sell a fix for')
    : `${def.sub}${filtered !== list.length ? ` · ${list.length} of ${filtered} shown` : ''}`;
  const web = list.filter((o) => o.path === 'WEBSITE').length;
  const fix = list.filter((o) => o.path === 'FIX').length;
  u.split.replaceChildren(h('div', {}, h('span', {}, h('i', { class: 'dot web' }), 'Need a website'), h('b', { text: String(web) })),
    h('div', {}, h('span', {}, h('i', { class: 'dot fix' }), 'Need a fix'), h('b', { text: String(fix) })));
  u.split.hidden = S.items.length === 0;
  u.next.replaceChildren(...(def.key === 'discover' ? nextStep(S.summary, S.items) : []));
  u.planned.replaceChildren('');
  u.feed.replaceChildren(...(list.length ? list.map(card) : [emptyState(def)]));
  const placeable = S.summary?.postcodeUnplaced ?? 0;
  u.map.update(list, { anyBusinesses: (S.summary?.businesses ?? 0) > 0, placeable, onLocate: locate });
}

/** FIND → QUALIFY → PRIORITISE → ANALYSE → OPPORTUNITY, each a count of the workspace's own records. */
function rail(sm) {
  if (!sm) return [];
  const f = sm.funnel;
  const run = sm.nextRun ? `#/find/run/${sm.nextRun.searchRunId}` : '#/find';
  const steps = [
    ['Find', sm.businesses, 'businesses found', '#/find'],
    ['Qualify', f.qualified, 'match your criteria', run],
    ['Prioritise', f.waiting, 'chosen to analyse', run],
    ['Analyse', f.analysed, 'analysed', run],
    ['Opportunity', f.opportunities, 'with a problem to sell', '#/'],
  ];
  const cur = sm.businesses === 0 ? 0 : f.waiting > 0 ? 3 : f.opportunities > 0 ? 4 : f.analysed === 0 ? 2 : 3;
  return [h('ol', {}, steps.map(([label, n, sub, href], i) => h('li', { class: i < cur ? 'done' : i === cur ? 'cur' : '' },
    h('a', { href, title: `${n} ${sub}` }, h('span', { class: 'k', text: label }), h('b', { text: String(n) }), h('small', { text: sub })))))];
}

/** The one thing to do next, from the counts. Never a guess about the future. */
function nextStep(sm, items) {
  if (!sm) return [];
  const f = sm.funnel;
  const card = (eyebrow, title, body, ...actions) => h('section', { class: 'ds-card', 'aria-label': 'Next step' },
    h('span', { class: 'eyebrow', text: eyebrow }), h('h3', { text: title }), body ? h('p', { text: body }) : null, h('div', { class: 'row' }, ...actions));
  if (sm.businesses === 0) return [intro()];
  if (f.waiting > 0 && sm.nextRun) {
    return [card('Next step · analyse', `${plural(sm.nextRun.waiting, 'business is', 'businesses are')} waiting to be analysed`,
      `In “${sm.nextRun.name}”. Scopely reads each website and records only what it observes.`,
      h('a', { class: 'btn primary', href: `#/find/run/${sm.nextRun.searchRunId}` }, 'Open and analyse'))];
  }
  if (items.length === 0 && sm.nextRun && sm.nextRun.toChoose > 0) {
    return [card('Next step · prioritise', `Choose which businesses to analyse`,
      `${plural(sm.nextRun.toChoose, 'business', 'businesses')} in “${sm.nextRun.name}” passed or need a look at your criteria.`,
      h('a', { class: 'btn primary', href: `#/find/run/${sm.nextRun.searchRunId}` }, 'Choose businesses'))];
  }
  if (items.length === 0) {
    return [card('Next step · find more', f.analysed ? 'No observed problems yet' : 'Nothing analysed yet',
      f.analysed ? `Scopely analysed ${plural(f.analysed, 'business', 'businesses')} and found no problem it can prove and sell a fix for. That is a result, not an error: add more businesses.`
        : 'Add businesses, then analyse them.',
      h('a', { class: 'btn primary', href: '#/find' }, 'Find businesses'))];
  }
  const fresh = items.filter((o) => o.stage === 'OPPORTUNITIES');
  if (fresh.length) {
    const top = [...fresh].sort(SORTS.evidence)[0];
    return [card('Next step · prove and build', `Review ${top.business}`,
      `${top.issue ?? 'An observed problem'}. Open the Case File to see the evidence, then build the ${top.path === 'WEBSITE' ? 'website' : 'fix'}.`,
      h('a', { class: 'btn primary', href: `#/o/${top.opportunityId}` }, 'Open Case File'))];
  }
  return [];
}

/** First run: what Scopely is and how to start. */
function intro() {
  const providerNote = 'A search uses your own Clay connection. No connection yet? Add businesses by website instead: it needs no provider.';
  return h('section', { class: 'ds-intro', 'aria-label': 'Get started' },
    h('span', { class: 'eyebrow', text: 'Welcome to Scopely' }),
    h('h3', { text: 'Find businesses with real problems. Prove them. Build the fix. Sell it.' }),
    h('ol', { class: 'ds-how' },
      h('li', {}, h('b', { text: 'Find' }), 'Add businesses you know by website, or search a provider.'),
      h('li', {}, h('b', { text: 'Analyse' }), 'Scopely reads each website and records what it observes: a broken contact link, no booking path, no website.'),
      h('li', {}, h('b', { text: 'Prove and build' }), 'Each problem becomes a Case File with its evidence. Build the website or the fix as a private draft.'),
      h('li', {}, h('b', { text: 'Sell, deliver, get paid' }), 'Draft the outreach, send it yourself, then record the reply, the delivery, the re-check and the money received.')),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/find' }, 'Add your first businesses')),
    h('p', { class: 'hint', text: providerNote }));
}

function emptyState(def) {
  if (S.items.length === 0) {
    return h('div', { class: 'empty' }, h('b', { text: 'No opportunities yet' }),
      'An opportunity appears when Scopely analyses a business and observes a problem you can sell a fix for. Nothing here is made up, so this list starts empty.');
  }
  if (def.key === 'discover') {
    return h('div', { class: 'empty' }, h('b', { text: 'No opportunities match these filters' }),
      h('p', {}, h('button', { class: 'btn sm', style: 'margin-top:10px', onclick: () => { S.f = { ...S.f, path: 'all', vertical: 'all', city: 'all', q: '' }; drawFilters(); drawFeed(); } }, 'Clear filters')));
  }
  const word = { opportunities: 'Opportunities you have not built yet', build: 'Opportunities with a built draft', sell: 'Opportunities you have pitched',
    deliver: 'Won work waiting to be delivered', verify: 'Delivered work that has been re-checked' }[def.key];
  return h('div', { class: 'empty' }, h('b', { text: 'Nothing here yet' }), `${word ?? 'Opportunities'} show here.`);
}

async function locate(btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/map/locate');
    toast(r.located ? `Placed ${plural(r.located, 'business', 'businesses')} on the map from ${r.located === 1 ? 'its postcode' : 'their postcodes'}.`
      : 'No business could be placed: the postcode directory does not know those postcodes.');
    await loadFeed();
    drawFeed();
  } catch (err) { if (btn) btn.disabled = false; fail(err); }
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
  // A fictional business on a reserved address (the API decides): never read it as a live prospect.
  const demo = o.demo ? h('span', { class: 'badge b-demo', title: 'A fictional business on a reserved address, for trying Scopely. Not a real prospect.', text: 'DEMO DATA' }) : null;
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
      h('div', { class: 'cBody' }, h('div', { class: 'row' }, badge, demo, status ? h('span', { class: 'chip', text: status }) : null),
        h('div', { class: 'cOpp', text: o.issue ?? 'Needs a website' }), steps, foot,
        o.buildable && !o.projectId ? h('button', { class: 'cAct web', onclick: (e) => { e.stopPropagation(); startBuild(o, e.currentTarget); } }, 'Build website') : null),
    ];
  } else {
    body = [h('div', { class: 'cBody' }, h('div', { class: 'row' }, badge, demo, status ? h('span', { class: 'chip', text: status }) : null), head,
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
