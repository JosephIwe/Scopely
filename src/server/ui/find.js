// Find (Slice 10): the seller's searches, provider discovery runs and the run's businesses in
// priority order. Every value comes from the server: qualification, priority and provenance are
// the server's, never worked out here.
//
// Routes (hash, under /app):
//   #/find            searches, the providers this server offers, and a new search
//   #/find/run/<id>   one run: provider calls, then its businesses, select for analysis, analyse
//
// Slice 11: a selected business is analysed one request at a time (so the screen can show
// progress); each analysed row says what Scopely found and links each opportunity to its Case File.
// What was observed, inferred and not observable comes from the server as written.
import { $app, api, date, fail, go, h, plural, remember, toast, when } from './lib.js';

const STATE = {
  QUALIFIED: ['Qualified', 'sage'], NEEDS_REVIEW: ['Needs review', 'amber'], REJECTED: ['Rejected', ''], DISCOVERED: ['Not checked', ''],
  SELECTED: ['Selected', 'blue'], ANALYSIS_QUEUED: ['Queued', 'blue'], ANALYZED: ['Analysed', 'blue'], OPPORTUNITY_FOUND: ['Opportunity', 'blue'],
  NO_OPPORTUNITY: ['No opportunity', ''],
};
const STAGE_WORD = {
  geography: 'Location', industry: 'Industry', size: 'Size', revenue: 'Revenue', structure: 'Structure', online_presence: 'Website',
  signals: 'Reviews', contactability: 'Contact details', exclusions: 'Exclusions',
};
const FINDING_NOTE = {
  opened: 'Opened as an opportunity', already_held: 'Already in an open opportunity', no_service: 'No service in your catalog covers this',
  not_a_lead: 'Recorded; never the lead of a pitch',
};
const STATE_WORD = { OBSERVED: 'Observed', INFERRED: 'Inferred', NOT_OBSERVABLE: 'Not observable' };
const ERROR_WORD = {
  auth: 'credential refused', rate_limited: 'rate limited', invalid_request: 'search refused', not_recorded: 'not recorded',
  provider_unavailable: 'provider unavailable', timeout: 'timed out', network: 'unreachable', malformed_response: 'unreadable answer',
};
const CRITERION_WORD = {
  country: 'country', region: 'region', city: 'city', postal_prefix: 'postcode', radius_km: 'distance', vertical: 'industry', subvertical: 'niche',
  specialty: 'specialty', employees: 'employees', revenue: 'revenue', website_required: 'website', website_absent: 'website', website_status: 'website',
  suppressed: 'on your do-not-contact list', excluded_domain: 'excluded domain',
};

function bar(back) {
  return h('header', { class: 'appbar' },
    h('a', { class: 'logo', href: '#/' }, h('i'), 'SCOPELY'), h('span', { class: 'sep' }),
    h('a', { class: 'back', href: back.href, text: `← ${back.label}` }));
}

export async function findView(hash) {
  const m = hash.match(/^#\/find\/run\/(\d+)$/);
  document.title = 'Scopely · Find';
  $app.replaceChildren(bar(m ? { href: '#/find', label: 'Searches' } : { href: '#/', label: 'Opportunities' }),
    h('main', { class: 'page fd' }, h('div', { class: 'skeleton', style: 'height:30px;width:40%' })));
  try {
    if (m) await runView(m[1]); else await homeView();
  } catch (err) {
    $app.querySelector('main').replaceChildren(h('div', { class: 'card empty' }, h('h2', { text: err.status === 404 ? 'Not found' : 'This could not be loaded' }),
      h('p', { class: 'muted', text: err.message })));
  }
}

// ------------------------------------------------------------------ searches

async function homeView() {
  const d = await api('GET', '/discovery');
  const main = $app.querySelector('main');
  const providers = d.providers;
  const pchips = providers.length ? providers.map((p) => h('span', { class: `fd-chip ${p.ready ? 'ok' : ''}` },
    h('b', { text: p.label }), p.transport === 'recorded' ? ' · recorded responses' : p.ready ? ' · connected' : ' · not connected'))
    : [h('span', { class: 'fd-chip', text: 'No discovery provider is set up on this server' })];

  const list = h('div', { class: 'fd-searches' });
  const draw = () => list.replaceChildren(...(d.searches.length ? d.searches.map((s) => searchRow(s, providers, d.runs ?? []))
    : [h('div', { class: 'card empty' }, h('h2', { text: 'No searches yet' }), h('p', { class: 'muted', text: 'Describe who you sell to and Scopely will find them.' }))]));
  draw();

  main.replaceChildren(
    h('div', { class: 'fd-head' }, h('div', {}, h('span', { class: 'eyebrow', text: 'Find' }), h('h1', { text: 'Find businesses' }),
      h('p', { class: 'lead muted', text: 'Search a data provider for businesses that fit who you sell to. Scopely checks every one against your search before you spend anything analysing it.' })),
      h('div', { class: 'fd-chips', 'aria-label': 'Providers' }, pchips)),
    h('div', { class: 'fd-grid' }, h('section', { 'aria-label': 'Your searches' }, h('h2', { class: 'fd-h2', text: 'Your searches' }), list),
      h('section', { class: 'card fd-form', 'aria-label': 'New search' }, newSearchForm())));
}

function searchRow(s, providers, runs) {
  const mine = runs.filter((r) => r.searchId === s.searchId);
  const run = async (p, btn) => {
    btn.disabled = true;
    btn.textContent = `Searching ${p.label}…`;
    try {
      const r = await api('POST', `/searches/${s.searchId}/runs`, { provider: p.key });
      const res = r.result;
      if (res.error) toast(`${res.error.message} ${plural(res.discovered, 'business was', 'businesses were')} kept.`, { bad: true });
      else toast(`Found ${plural(res.discovered, 'business', 'businesses')}: ${res.qualification.qualified} qualified.`);
      go(`#/find/run/${r.searchRunId}`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Run with ${p.label}`;
      fail(err);
    }
  };
  return h('article', { class: 'card fd-search' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', { text: s.name }),
      h('div', { class: 'small muted', text: s.lastRunAt ? `${plural(s.runs, 'run', 'runs')} · last ${date(s.lastRunAt)}` : 'Not run yet' })),
      providers.map((p) => h('button', { class: 'btn sm primary', disabled: !p.ready, title: p.ready ? '' : `Connect ${p.label} first`,
        onclick: (e) => run(p, e.currentTarget) }, `Run with ${p.label}`))),
    mine.length ? h('ol', { class: 'fd-runs' }, mine.slice(0, 4).map((r) => h('li', {},
      h('a', { href: `#/find/run/${r.searchRunId}`, text: when(r.startedAt) }), h('span', { class: 'muted', text: ` · ${plural(r.discovered, 'business', 'businesses')} found, ${r.qualified} qualified` })))) : null);
}

function newSearchForm() {
  const f = {};
  const input = (key, attrs = {}) => (f[key] = h('input', { name: key, ...attrs }));
  const field = (label, el, hint, opt) => h('label', { class: 'field' }, h('span', { class: 'lab' }, label, opt ? h('em', { text: 'optional' }) : null), el,
    hint ? h('div', { class: 'hint', text: hint }) : null);
  let presence = 'any';
  const seg = h('div', { class: 'seg full', role: 'group', 'aria-label': 'Website' }, [['any', 'Any'], ['required', 'Has one'], ['absent', 'Has none']].map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === presence), onclick: (e) => { presence = v; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, l)));
  const save = h('button', { class: 'btn primary block', type: 'submit' }, 'Save search');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const body = {
        name: f.name.value, verticals: f.verticals.value, countryCode: f.countryCode.value, city: f.city.value,
        employeeMin: f.employeeMin.value, employeeMax: f.employeeMax.value, websitePresence: presence,
        revenueMin: f.revenueMin.value, revenueMax: f.revenueMax.value, revenueCurrency: f.revenueCurrency.value,
        maxDiscoveredPerRun: f.maxDiscoveredPerRun.value, maxBusinessesToAnalyze: f.maxBusinessesToAnalyze.value,
      };
      await api('POST', '/searches', body);
      toast('Search saved.');
      await findView('#/find');
    } catch (err) { save.disabled = false; fail(err); }
  } },
    h('h2', { class: 'fd-h2', text: 'New search' }),
    field('Name', input('name', { required: true, maxlength: 120, placeholder: 'Independent clinics' })),
    field('Industries', input('verticals', { maxlength: 400 }), 'As the provider names them, separated by commas.'),
    h('div', { class: 'fd-two' }, field('Country', input('countryCode', { maxlength: 2, placeholder: 'GB', autocapitalize: 'characters' }), null, true),
      field('City', input('city', { maxlength: 120 }), null, true)),
    h('div', { class: 'fd-two' }, field('Fewest employees', input('employeeMin', { inputmode: 'numeric' }), null, true),
      field('Most employees', input('employeeMax', { inputmode: 'numeric' }), null, true)),
    h('div', { class: 'fd-three' }, field('Lowest revenue', input('revenueMin', { inputmode: 'numeric', placeholder: '1000000' }), null, true),
      field('Highest revenue', input('revenueMax', { inputmode: 'numeric' }), null, true),
      field('Currency', input('revenueCurrency', { maxlength: 3, placeholder: 'USD', autocapitalize: 'characters' }))),
    h('p', { class: 'hint fd-rev', text: 'Yearly revenue in whole units, never converted. Clay filters revenue in US dollars only; in another currency only Scopely checks it. Clay’s revenue ranges carry no currency, so they are not recorded as facts and each business found goes to review on revenue.' }),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Website'), seg),
    h('div', { class: 'fd-two' }, field('Find per run', input('maxDiscoveredPerRun', { inputmode: 'numeric', value: '40', required: true }), 'Up to 100.'),
      field('Analyse at most', input('maxBusinessesToAnalyze', { inputmode: 'numeric' }), null, true)),
    h('p', { class: 'hint', text: 'A provider search needs an industry or a city. Everything else is checked by Scopely on each business found.' }),
    h('div', { style: 'margin-top:18px' }, save));
  return form;
}

// ------------------------------------------------------------------ one run

const fmt = (v) => {
  if (v === null || v === undefined) return 'not known';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    if ('exact' in v || 'min' in v) {
      const lo = v.exact ?? v.min; const hi = v.exact ?? v.max;
      return lo === null && hi === null ? 'not known' : lo === hi ? String(lo) : `${lo ?? '?'}–${hi ?? '?'}`;
    }
    return JSON.stringify(v);
  }
  return String(v);
};

function reason(b) {
  const q = b.qualification ?? [];
  if (b.state === 'REJECTED') {
    const c = q.find((x) => x.stage === b.failedStage && x.verdict === 'fail');
    if (!c) return STAGE_WORD[b.failedStage] ?? b.failedStage;
    if (c.criterion === 'suppressed') return 'On your do-not-contact list';
    return `${STAGE_WORD[c.stage]}: ${CRITERION_WORD[c.criterion] ?? c.criterion} is ${fmt(c.actual)}, wanted ${fmt(c.expected)}`;
  }
  if (b.state === 'NEEDS_REVIEW') {
    const unknown = q.filter((x) => x.verdict === 'unknown').map((x) => CRITERION_WORD[x.criterion] ?? x.criterion);
    return `Not known yet: ${[...new Set(unknown)].join(', ')}`;
  }
  if (b.state === 'QUALIFIED') return `Meets all ${plural(q.length, 'check', 'checks')}`;
  return '';
}

const size = (e) => {
  if (e.count === null && e.min === null && e.max === null) return 'Size not known';
  const n = e.count !== null ? String(e.count) : e.min === e.max ? String(e.min) : e.max === null ? `${e.min}+` : `${e.min}–${e.max}`;
  return `${n} employees · ${String(e.basis ?? '').toLowerCase()}`;
};

async function runView(id) {
  const v = await api('GET', `/runs/${id}`);
  document.title = `Scopely · ${v.searchName}`;
  const main = $app.querySelector('main');
  const c = v.counts;
  const selectedNow = ['SELECTED', 'ANALYSIS_QUEUED', 'ANALYZED', 'OPPORTUNITY_FOUND', 'NO_OPPORTUNITY'].reduce((s, k) => s + (c[k] ?? 0), 0);
  const stat = (label, n, cls = '') => h('div', { class: `fd-stat ${cls}` }, h('b', { text: String(n) }), h('span', { text: label }));
  const e = v.economics;
  const recorded = v.operations.length > 0 && v.operations.every((o) => o.transport === 'recorded');
  const cost = e.costBasis === 'REPORTED' ? `${e.providerCredits} provider credits` : e.costBasis === 'NONE' ? 'No provider calls' : 'Cost not reported by the provider';

  const opsTable = h('table', { class: 'fd-table fd-ops' },
    h('thead', {}, h('tr', {}, ['Call', 'Result', 'Businesses', 'Time', 'Cost'].map((t) => h('th', { text: t })))),
    h('tbody', {}, v.operations.map((o) => h('tr', {},
      h('td', {}, o.operation === 'search' ? 'Search' : 'Next page', h('span', { class: 'muted small', text: ` · ${o.provider}${o.transport === 'recorded' ? ', recorded' : ''}` })),
      h('td', {}, o.status === 'SUCCEEDED' ? h('span', { class: 'badge sage', text: 'OK' }) : h('span', { class: 'badge', text: `Failed · ${ERROR_WORD[o.errorCode] ?? o.errorCode}` }),
        o.attempts > 1 ? h('span', { class: 'muted small', text: ` after ${o.attempts} tries` }) : null),
      h('td', { text: o.resultCount === null ? '–' : String(o.resultCount) }),
      h('td', { text: `${(o.latencyMs / 1000).toFixed(2)} s` }),
      h('td', { class: 'muted', text: o.costBasis === 'REPORTED' ? (o.providerCredits !== null ? `${o.providerCredits} credits` : `${o.providerCost.amount} ${o.providerCost.currency}`) : 'Not reported' })))));

  let filter = 'all';
  const picked = new Set();
  const listEl = h('div', { class: 'fd-biz', role: 'list' });
  const count = h('span');
  const by = h('input', { 'aria-label': 'Selected by', placeholder: 'Your name', value: remember('scopely.find.by'), maxlength: 80 });
  const selBtn = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
    selBtn.disabled = true;
    try {
      remember('scopely.find.by', by.value.trim());
      await api('POST', `/runs/${id}/select`, { businessIds: [...picked], selectedBy: by.value });
      toast(`${plural(picked.size, 'business', 'businesses')} selected for analysis.`);
      await findView(`#/find/run/${id}`);
    } catch (err) { selBtn.disabled = false; fail(err); }
  } }, 'Select for analysis');
  // Slice 11: analyse the businesses selected but not analysed yet, one request each.
  const waiting = () => v.businesses.filter((b) => b.state === 'SELECTED' || (b.state === 'ANALYSIS_QUEUED' && !b.analysis));
  const progress = h('span', { class: 'fd-progress', role: 'status', 'aria-live': 'polite' });
  const anaBtn = h('button', { class: 'btn dark', onclick: async () => {
    const who = by.value.trim();
    if (!who) { by.focus(); fail(new Error('Say who is asking for this analysis.')); return; }
    remember('scopely.find.by', who);
    const todo = waiting();
    anaBtn.disabled = true;
    selBtn.disabled = true;
    let found = 0;
    try {
      for (const [i, b] of todo.entries()) {
        progress.textContent = `Analysing ${i + 1} of ${todo.length}: ${b.name}…`;
        const r = await api('POST', `/runs/${id}/businesses/${b.businessId}/analyze`, { requestedBy: who });
        b.state = r.state;
        b.analysis = { analysisId: r.analysisId, outcome: r.analysis.outcome, findings: r.analysis.findings.length, opportunityIds: r.opportunityIds };
        found += r.opportunityIds.length;
        drawList();
      }
      toast(`Analysed ${plural(todo.length, 'business', 'businesses')}: ${plural(found, 'opportunity', 'opportunities')} found.`);
      await findView(`#/find/run/${id}`);
    } catch (err) {
      progress.textContent = '';
      fail(err);
      await findView(`#/find/run/${id}`);
    }
  } });
  const sync = () => {
    count.textContent = picked.size ? `${picked.size} chosen` : 'Choose qualified businesses to analyse';
    selBtn.disabled = picked.size === 0;
    const n = waiting().length;
    anaBtn.textContent = `Analyse ${plural(n, 'selected business', 'selected businesses')}`;
    anaBtn.hidden = n === 0;
  };
  const matches = (b) => filter === 'all' || (filter === 'selected' ? ['SELECTED', 'ANALYSIS_QUEUED', 'ANALYZED', 'OPPORTUNITY_FOUND', 'NO_OPPORTUNITY'].includes(b.state) : b.state === filter);
  const drawList = () => {
    const rows = v.businesses.filter(matches);
    listEl.replaceChildren(...(rows.length ? rows.map((b) => {
      const [word, tone] = STATE[b.state] ?? [b.state, ''];
      const can = b.state === 'QUALIFIED';
      const box = h('input', { type: 'checkbox', 'aria-label': `Choose ${b.name}`, disabled: !can, checked: picked.has(b.businessId),
        onchange: (ev) => { if (ev.target.checked) picked.add(b.businessId); else picked.delete(b.businessId); sync(); } });
      const where = [b.city, b.region, b.countryCode].filter(Boolean).join(', ') || 'Location not known';
      const prov = b.provenance;
      return h('div', { class: `fd-row ${can ? '' : 'off'}`, role: 'listitem' },
        h('span', { class: 'fd-pri', text: String(b.priority) }), box,
        h('div', { class: 'fd-main' }, h('div', { class: 'row' }, h('b', { text: b.name }), h('span', { class: `badge ${tone}`, text: word }),
          b.knownBefore ? h('span', { class: 'badge', title: 'This workspace already held this business', text: 'Known' }) : null),
          h('div', { class: 'small muted' }, [b.domain ?? 'No website address', where, b.vertical, size(b.employees)].filter(Boolean).join(' · ')),
          h('div', { class: 'small fd-why', text: reason(b) }), analysisLine(id, b)),
        h('div', { class: 'fd-prov small muted' }, prov ? [h('span', { text: prov.provider ? `From ${prov.provider[0].toUpperCase()}${prov.provider.slice(1)}` : 'Recorded by hand' }),
          h('span', { text: when(prov.observedAt) })] : null));
    }) : [h('div', { class: 'empty muted', text: 'Nothing in this view.' })]));
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [['all', `All ${v.businesses.length}`], ['QUALIFIED', `Qualified ${c.QUALIFIED ?? 0}`],
    ['NEEDS_REVIEW', `Needs review ${c.NEEDS_REVIEW ?? 0}`], ['REJECTED', `Rejected ${c.REJECTED ?? 0}`], ['selected', `Selected ${selectedNow}`]].map(([k, l]) =>
    h('button', { 'aria-pressed': String(filter === k), onclick: (ev) => { filter = k; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === ev.currentTarget))); drawList(); } }, l)));
  drawList();
  sync();

  main.replaceChildren(
    h('div', { class: 'fd-head' }, h('div', {}, h('span', { class: 'eyebrow', text: 'Search run' }), h('h1', { text: v.searchName }),
      h('p', { class: 'muted', text: `${v.operations[0] ? when(v.operations[0].startedAt) : ''}${v.maxDiscoveredPerRun ? ` · finds up to ${v.maxDiscoveredPerRun}` : ''}${v.maxBusinessesToAnalyze ? ` · analyses up to ${v.maxBusinessesToAnalyze}` : ''}` }))),
    h('div', { class: 'fd-stats' }, stat('Found', v.businesses.length), stat('Qualified', c.QUALIFIED ?? 0, 'ok'), stat('Needs review', c.NEEDS_REVIEW ?? 0, 'warn'),
      stat('Rejected', c.REJECTED ?? 0), stat('Selected', selectedNow, 'sel')),
    h('section', { class: 'card fd-econ', 'aria-label': 'Provider calls' },
      h('div', { class: 'row' }, h('h2', { class: 'fd-h2 grow', text: 'Provider calls' }), recorded ? h('span', { class: 'badge amber', text: 'Recorded responses · no live call' }) : null),
      h('p', { class: 'small muted', text: `${plural(e.operations, 'call', 'calls')} · ${plural(e.results, 'result', 'results')} · ${e.failed} failed · ${(e.totalLatencyMs / 1000).toFixed(2)} s · ${cost}` }),
      v.operations.length ? opsTable : null,
      v.operations.some((o) => o.status === 'FAILED') ? h('p', { class: 'small fd-err', text: v.businesses.length
        ? `The provider stopped answering partway through. The ${plural(v.businesses.length, 'business', 'businesses')} found before that are kept below.`
        : 'The provider did not return any businesses for this run. Nothing was kept.' }) : null),
    h('section', { 'aria-label': 'Businesses' }, h('div', { class: 'row fd-listhead' }, h('h2', { class: 'fd-h2 grow', text: 'Businesses, in priority order' }), seg), listEl),
    h('div', { class: 'fd-selbar' }, h('div', { class: 'fd-count' }, count, progress), h('span', { class: 'grow' }), by, selBtn, anaBtn));
}

// ------------------------------------------------------------------ analysis (Slice 11)

function analysisLine(runId, b) {
  const a = b.analysis;
  if (!a) {
    if (b.state === 'SELECTED') return h('div', { class: 'small muted fd-ana', text: 'Selected · not analysed yet' });
    return null;
  }
  const words = a.outcome === 'NO_ADDRESS' ? 'No website address is known, so nothing was requested'
    : a.outcome === 'REFUSED' ? 'Its address is not on the public web, so it was never requested'
      : `Analysed · ${plural(a.findings, 'finding', 'findings')}`;
  const detail = h('div', { class: 'fd-detail', hidden: true });
  const more = h('button', { class: 'btn sm ghost', 'aria-expanded': 'false', onclick: async (e) => {
    const btn = e.currentTarget;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Hide what Scopely saw' : 'What Scopely saw';
    detail.hidden = !open;
    if (open && !detail.childElementCount) {
      detail.replaceChildren(h('div', { class: 'skeleton', style: 'height:18px;width:60%' }));
      try { detail.replaceChildren(analysisDetail(await api('GET', `/runs/${runId}/businesses/${b.businessId}/analysis`))); } catch (err) { detail.replaceChildren(); fail(err); }
    }
  } }, 'What Scopely saw');
  return h('div', { class: 'fd-ana' },
    h('div', { class: 'row' }, h('span', { class: 'small', text: words }),
      a.opportunityIds.map((o, i) => h('a', { class: 'btn sm primary', href: `#/o/${o}` }, a.opportunityIds.length > 1 ? `Open Case File ${i + 1}` : 'Open Case File')),
      a.outcome === 'CHECKED' ? more : null),
    detail);
}

function analysisDetail(v) {
  const page = v.page;
  const head = h('p', { class: 'small muted' }, `Requested ${v.requestedUrl ?? 'nothing'} ${when(v.startedAt)} for ${v.requestedBy}`,
    page ? ` · ${page.httpStatus === null ? 'no answer' : `answered ${page.httpStatus}`}${page.redirects.length ? ` after ${plural(page.redirects.length, 'redirect', 'redirects')}` : ''}` : '',
    ` · ${plural(v.requests, 'request', 'requests')}, cost not reported · website status: ${String(v.website.status).replace('WEBSITE_', '').replace('_', ' ').toLowerCase()}`);
  const findings = v.findings.length ? h('div', { class: 'fd-group' }, h('h3', { text: 'Findings' }),
    h('ul', {}, v.findings.map((f) => h('li', {},
      h('div', {}, h('b', { text: f.plainIssue }), ' ', h('span', { class: `badge ${f.confidence === 'HIGH' ? 'amber' : ''}`, text: `${f.confidence.toLowerCase()} · ${f.issueCode}` })),
      h('code', { class: 'fd-quote', text: f.quote }),
      h('div', { class: 'small muted' }, `${FINDING_NOTE[f.note] ?? f.note} · seen ${when(f.observedAt)} on ${f.url} · ${f.rule}`,
        f.opportunityId ? h('span', {}, ' · ', h('a', { href: `#/o/${f.opportunityId}`, text: 'Case File' })) : null))))) : null;
  const group = (title, state) => {
    const items = v.observations.filter((o) => o.state === state);
    return items.length ? h('div', { class: 'fd-group' }, h('h3', { text: `${title} · ${items.length}` }),
      h('ul', {}, items.map((o) => h('li', { class: 'small' }, h('span', { class: `fd-dot ${o.result ?? 'na'}`, 'aria-hidden': 'true' }), o.fact)))) : null;
  };
  return h('div', {}, head, findings, group(STATE_WORD.OBSERVED, 'OBSERVED'), group(STATE_WORD.INFERRED, 'INFERRED'), group(STATE_WORD.NOT_OBSERVABLE, 'NOT_OBSERVABLE'));
}
