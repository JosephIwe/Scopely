// The Case File (Slice 8): one opportunity, organised the way the seller works it.
//   What is the opportunity? Why do we believe it? What can we build or fix? Who can buy it?
//   What did the seller do? What happened?
// It shows what the server returned and nothing else: an unknown value reads as not known, a
// later stage reads as planned, and nothing on this page sends anything to anyone (U4). The
// builders open unchanged from section 05.
//
// Slice 9 (Prospect Readiness) adds the writers a seller needs to make the opportunity actionable,
// each next to what it changes: a re-check under each finding (02), the company register facts (03),
// contacts and suppression (07), and a readiness summary under the business name that says, from the
// server's gates, what is missing and what is ready.
import { api, date, fail, go, h, money, remember, toast, when } from './lib.js';

const WEBSITE_STATUS = {
  WEBSITE_NOT_OBSERVED: 'Not observed', WEBSITE_PRESENT: 'Found', WEBSITE_UNREACHABLE: 'Unreachable', WEBSITE_NEEDS_REVIEW: 'Needs review', UNKNOWN: 'Not checked',
};
const LABEL = { VERIFIED: 'VERIFIED', PUBLICLY_FOUND: 'PUBLICLY FOUND', UNVERIFIED: 'UNVERIFIED' };
const BASIS = { corporate_subscriber: 'Corporate subscriber', consent: 'Consent', not_permitted: 'Not permitted', unknown: 'Not known' };
const CHANNELS = [['email', 'Email'], ['phone', 'Phone'], ['in_person', 'In person'], ['linkedin', 'LinkedIn'], ['whatsapp', 'WhatsApp'], ['social', 'Other social'], ['other', 'Other']];
const REPLIES = [['positive', 'Interested'], ['question', 'Asked a question'], ['pricing', 'Asked about price'], ['not_now', 'Not now'],
  ['not_interested', 'Not interested'], ['opt_out', 'Asked not to be contacted'], ['wrong_person', 'Wrong person']];
const KIND_WORD = { pitched: 'Pitched', replied: 'Reply', call: 'Call', won: 'Won', lost: 'Lost', delivered: 'Delivered', voided: 'Correction' };
const FIX_STEPS = [['problem', 'Problem'], ['proof', 'Proof'], ['fix', 'Fix'], ['beforeAfter', 'Before / After'], ['confirm', 'Confirm'], ['show', 'Show']];
const VERSION_WORD = { DRAFT: 'Draft', APPROVED: 'Approved', SHOWN: 'Shown' };

const humanize = (s) => s ? s.replace(/[_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) : s;
const notKnown = (label = 'Not known') => h('span', { class: 'unk', text: label });
const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v ?? notKnown())]));
const sec = (num, title, opts, ...kids) => h('section', { class: 'sec', id: `cf-${num}`, 'aria-labelledby': `cf-${num}-h` },
  h('h3', { id: `cf-${num}-h` }, h('span', { class: 'num', text: num }), title, opts?.planned ? h('span', { class: 'plan', text: 'PLANNED' }) : null), ...kids);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const abs = (u) => new URL(u, location.href).href;

// Slice 9 vocabularies, in the seller's words. Values are the stored ones.
const RECHECK = [['confirmed', 'Still there'], ['gone', 'No longer there'], ['changed', 'Changed']];
const SOURCES = [['website_contact_page', 'The business’s website'], ['business_listing', 'A business listing'], ['company_register', 'The company register'],
  ['conversation', 'They gave it to me'], ['referral', 'A referral'], ['other', 'Somewhere else']];
const LABELS = [['UNVERIFIED', 'Not verified'], ['PUBLICLY_FOUND', 'Publicly found'], ['VERIFIED', 'Verified with the business']];
const BASES = [['unknown', 'Not known'], ['corporate_subscriber', 'Corporate subscriber (a company’s address)'], ['consent', 'They consented'], ['not_permitted', 'Not permitted']];
const COMPANY_TYPES = [['ltd', 'Private limited company (Ltd)'], ['llp', 'Limited liability partnership (LLP)'], ['plc', 'Public limited company (PLC)'],
  ['private-limited-guarant-nsc', 'Limited by guarantee'], ['private-unlimited', 'Private unlimited company'], ['sole_trader', 'Sole trader'], ['partnership', 'Partnership'], ['other', 'Another type']];
const COMPANY_STATUSES = [['active', 'Active'], ['dissolved', 'Dissolved'], ['liquidation', 'In liquidation'], ['administration', 'In administration'],
  ['receivership', 'In receivership'], ['voluntary-arrangement', 'Voluntary arrangement'], ['insolvency-proceedings', 'Insolvency proceedings'], ['converted-closed', 'Converted or closed']];
const REGISTERS = [['', 'Not recorded'], ['uk_companies_house', 'Companies House (UK)'], ['other', 'Another register']];
const REASONS = [['opt_out', 'Asked not to be contacted'], ['dnc', 'Do not contact'], ['bounce', 'Email bounced'], ['complaint', 'Complained'], ['contacted', 'Already contacted']];
const READY_WORD = { READY: 'READY', NOT_READY: 'NOT READY', SUPPRESSED: 'SUPPRESSED' };
const CHECK_SECTION = { evidence: '02', company: '03', contact: '07', lawful_basis: '07', suppression: '07' };
const word = (list, v) => list.find(([k]) => k === v)?.[1] ?? v;

const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lab', text: label }), el, hint ? h('span', { class: 'hint', text: hint }) : null);
const select = (label, list, value) => h('select', { 'aria-label': label }, list.map(([k, l]) => h('option', { value: k, selected: k === (value ?? '') }, l)));
const input = (label, value, attrs = {}) => h('input', { type: 'text', 'aria-label': label, value: value ?? '', autocomplete: 'off', ...attrs });
const byInput = () => h('input', { type: 'text', value: remember('scopely.approver'), placeholder: 'Your name', maxlength: 120, autocomplete: 'name', 'aria-label': 'Recording as' });

/** Re-reads the Case File and keeps the reader where they were. */
async function refresh(ctx) {
  const at = document.querySelector('.cf .scroll')?.scrollTop ?? 0;
  await ctx.reload();
  const sc = document.querySelector('.cf .scroll');
  if (sc) sc.scrollTop = at;
}

/** A closed form under a summary line: one writer, one Record button, the server's refusal in a toast. */
function writer(summary, rows, label, submit, ctx, note) {
  const btn = h('button', { class: 'btn dark', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const done = await submit();
      if (done === false) { btn.disabled = false; return; }
      toast(typeof done === 'string' ? done : 'Recorded');
      await refresh(ctx);
    } catch (err) { fail(err); btn.disabled = false; }
  });
  const body = h('div', { class: 'recf' });
  const draw = () => body.replaceChildren(...(typeof rows === 'function' ? rows() : rows));
  draw();
  return Object.assign(h('details', { class: 'act' }, h('summary', { text: summary }),
    h('div', { class: 'record' }, body, h('div', { class: 'row' }, btn, note ? h('span', { class: 'note', text: note }) : null))), { redraw: draw });
}

const needBy = (by) => {
  if (by.value.trim()) { remember('scopely.approver', by.value.trim()); return true; }
  by.focus(); toast('Say who is recording this.', { bad: true }); return false;
};

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast('Copy did not work in this browser. Select the text instead.', { bad: true }); }
}

export function renderCaseFile(cf, ctx) {
  const web = cf.path === 'WEBSITE';
  const fix = cf.path === 'FIX';
  const top = cf.evidence[0] ?? null;
  const root = h('div', { class: `cf ${web ? 'web' : fix ? 'fix' : ''}` });
  const badge = web ? h('span', { class: 'badge b-web', text: 'WEBSITE OPPORTUNITY' }) : fix ? h('span', { class: 'badge b-fix', text: 'FIX OPPORTUNITY' }) : null;

  root.append(
    h('div', { class: 'cHead' }, h('a', { class: 'back', href: ctx.back }, '← Back'), h('span', { class: 'eyebrow', text: 'Case file' }), h('span', { class: 'cHeadR' }, badge)),
    h('div', { class: 'scroll' },
      h('header', { class: 'sec intro' },
        h('span', { class: 'eyebrow', text: [cf.business.vertical, cf.business.location.city].filter(Boolean).join(' · ') || 'Business' }),
        h('h2', { class: 'bizName', text: cf.business.name }), readiness(cf)),
      situation(cf, top), evidence(cf, ctx), business(cf, ctx), service(cf), build(cf), beforeAfter(cf), buyer(cf, ctx), sell(cf, ctx), deliver(cf)));
  return root;
}

// ---------------------------------------------------------------- prospect readiness (Slice 9)

/** What the server's gates say is missing before the seller may act. Each line jumps to where it is fixed. */
function readiness(cf) {
  const r = cf.readiness;
  const jump = (key) => () => document.getElementById(`cf-${CHECK_SECTION[key]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return h('div', { class: `ready r-${r.status.toLowerCase()}`, role: 'status', 'aria-label': 'Prospect readiness' },
    h('div', { class: 'row' }, h('span', { class: 'eyebrow', text: 'Prospect readiness' }),
      h('span', { class: `badge ${r.status === 'READY' ? 'b-ver' : r.status === 'SUPPRESSED' ? 'b-sup' : 'b-rev'}`, text: READY_WORD[r.status] })),
    r.status === 'READY' ? h('p', { class: 'hint', text: 'Ready for seller action. Contact the business from your own inbox, phone or in person, then record what you did in 08.' }) : null,
    h('ul', { class: 'rchecks' }, r.checks.map((c) => h('li', { class: c.state },
      h('i', { 'aria-hidden': 'true', text: c.state === 'done' ? '✓' : c.state === 'blocked' ? '✕' : '!' }),
      h('span', {}, h('button', { type: 'button', class: 'lnk', onclick: jump(c.key) }, c.label), detailOf(cf, c) ? h('small', { text: detailOf(cf, c) }) : null)))));
}

/** A recorded company type and status in the register's words; every other detail as the server wrote it. */
const detailOf = (cf, c) => c.key === 'company' && c.state === 'done'
  ? [word(COMPANY_TYPES, cf.business.company.type), word(COMPANY_STATUSES, cf.business.company.status)].filter(Boolean).join(' · ') : c.detail;

// ---------------------------------------------------------------- 01 opportunity / situation

function situation(cf, top) {
  const web = cf.path === 'WEBSITE';
  return sec('01', 'Opportunity', null,
    h('div', { class: `types ${web ? 'web' : 'fix'}` },
      h('div', { class: web ? 'on' : '' }, h('b', {}, h('i'), 'Needs a website'), h('small', { text: 'Opportunity → build a website' })),
      h('div', { class: cf.path === 'FIX' ? 'on' : '' }, h('b', {}, h('i'), 'Needs a fix'), h('small', { text: 'Observed problem → prove → build a fix' }))),
    h('div', { class: 'label', text: 'What Scopely found' }),
    h('p', { class: 'lead', text: top ? top.plainIssue : 'Nothing observed yet.' }),
    cf.situation.whyItMatters ? h('p', { class: 'why', text: cf.situation.whyItMatters }) : h('p', { class: 'why unk', text: 'Why it matters has not been written for this opportunity.' }),
    cf.situation.notObservable ? h('div', { class: 'note' }, h('b', { text: 'What Scopely could not see. ' }), cf.situation.notObservable) : null,
    kv([['Type', humanize(cf.opportunityType)], ['Found', date(cf.createdAt)], ['Findings', String(cf.evidence.length)]]));
}

// ---------------------------------------------------------------- 02 evidence / proof

function recheckLine(e) {
  if (!e.recheck) return h('span', { class: 'unk', text: e.confidence === 'HIGH' ? 'Not re-checked yet' : 'Not re-checked' });
  if (e.recheck.result === 'confirmed') return h('span', { class: 'ok', text: `Re-checked ${date(e.recheck.at)} · still there` });
  return h('span', { class: 'bad', text: `Re-checked ${date(e.recheck.at)} · ${e.recheck.result === 'gone' ? 'no longer there' : 'changed'}` });
}

/** A person's visit to the finding's own page (Slice 9). Scopely fetches nothing. */
function recheckWriter(cf, e, ctx) {
  const options = e.claimState === 'OBSERVED' ? RECHECK : RECHECK.filter(([k]) => k === 'changed');
  let result = options[0][0];
  const notes = h('textarea', { rows: 2, maxlength: 2000, 'aria-label': 'What changed' });
  const by = byInput();
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What you saw' });
  const w = writer('Record a re-check', () => {
    seg.replaceChildren(...options.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(k === result), onclick: () => { result = k; w.redraw(); } }, l)));
    return [h('p', { class: 'hint', text: `Open ${e.url} now and look for the problem. Record what you saw; Scopely records it as your visit and fetches nothing.` }),
      field('What you saw', seg), result === 'changed' ? field('What changed', notes) : null, field('Recording as', by)].filter(Boolean);
  }, 'Record re-check', async () => {
    if (result === 'changed' && !notes.value.trim()) { notes.focus(); toast('Say what changed.', { bad: true }); return false; }
    if (!needBy(by)) return false;
    await api('POST', `/opportunities/${cf.opportunityId}/evidence/${e.evidenceId}/recheck`, { result, recordedBy: by.value.trim(), notes: result === 'changed' ? notes.value : null });
    return 'Re-check recorded';
  }, ctx, 'Re-checks are permanent. A later re-check replaces this one in the gates.');
  return w;
}

function evidence(cf, ctx) {
  if (!cf.evidence.length) return sec('02', 'Evidence', null, h('p', { class: 'unk', text: 'No evidence is linked to this opportunity.' }));
  const items = cf.evidence.map((e) => {
    const inferred = e.claimState !== 'OBSERVED';
    return h('div', { class: 'ev' },
      h('div', { class: 'row1' },
        h('span', { class: `badge ${inferred ? 'b-inf' : 'b-obs'}`, text: inferred ? 'INFERRED' : 'OBSERVED' }),
        h('span', { class: `conf ${e.confidence === 'HIGH' ? 'hi' : ''}`, text: `CONFIDENCE · ${e.confidence}` })),
      h('p', { class: 'evIssue', text: e.plainIssue }),
      e.visibleText ? h('div', { class: 'q', text: `“${e.visibleText}”` }) : null,
      kv([
        ['Page', h('a', { class: 'mono', href: e.url, target: '_blank', rel: 'noopener noreferrer', text: e.url })],
        e.observedHref ? ['Link opens', h('span', { class: 'mono', text: e.observedHref })] : null,
        [cf.path === 'FIX' ? 'Captured' : 'Checked', h('span', { class: 'mono', text: when(e.observedAt) })],
        ['Re-check', recheckLine(e)],
        ['Rule', h('span', { class: 'mono', text: `${e.rule.key} v${e.rule.version}` })],
      ]),
      h('details', { class: 'raw' }, h('summary', { text: 'Show evidence' }), h('pre', { class: 'mono', text: e.quote })),
      h('div', { class: 'evAct' }, recheckWriter(cf, e, ctx)));
  });
  return sec('02', cf.path === 'FIX' ? 'Evidence · proof' : 'Evidence', null, ...items,
    h('p', { class: 'hint', text: 'Observed means Scopely saw it on the page. Inferred claims are never presented as observed.' }));
}

// ---------------------------------------------------------------- 03 business

/** The company register facts the seller looked up (Slice 9). Nothing is looked up for them. */
function companyWriter(cf, ctx) {
  const c = cf.business.company;
  const register = select('Register', REGISTERS, c.register);
  const number = input('Company number', c.number, { maxlength: 20, placeholder: 'e.g. 01234567' });
  const type = select('Company type', [['', 'Choose…'], ...COMPANY_TYPES], c.type);
  const status = select('Company status', [['', 'Choose…'], ...COMPANY_STATUSES], c.status);
  const unregistered = () => ['sole_trader', 'partnership'].includes(type.value);
  const w = writer(c.type || c.status ? 'Update company status' : 'Record company status', () => [
    h('p', { class: 'hint', text: 'Copy these from the register entry you checked. Scopely does not look them up.' }),
    field('Company type', type), unregistered() ? null : field('Status', status), unregistered() ? null : field('Register', register),
    unregistered() ? null : field('Company number (optional)', number)].filter(Boolean), 'Record', async () => {
    if (!type.value) { type.focus(); toast('Choose the company type.', { bad: true }); return false; }
    const none = unregistered();
    await api('POST', `/opportunities/${cf.opportunityId}/company`, { type: type.value, status: none ? null : status.value || null,
      register: none ? null : register.value || null, number: none ? null : number.value || null });
    return 'Company status recorded';
  }, ctx);
  type.addEventListener('change', () => w.redraw());
  return w;
}

function business(cf, ctx) {
  const b = cf.business;
  const f = b.firmographics;
  const loc = [b.location.addressLine, b.location.city, b.location.region, b.location.postalCode, b.location.countryCode].filter(Boolean).join(', ');
  const site = b.websiteUrl || b.domain;
  const range = (x, fmt) => x.count !== undefined && x.count !== null ? fmt(x.count) : x.amount ? fmt(x.amount)
    : x.min !== null || x.max !== null ? `${x.min !== null ? fmt(x.min) : '?'}–${x.max !== null ? fmt(x.max) : '?'}` : null;
  const basis = (x) => x.basis ? ` · ${x.basis.toLowerCase()}${x.source ? `, ${x.source}` : ''}` : '';
  const emp = range(f.employees, String);
  const rev = f.revenue.currency ? range(f.revenue, (v) => money(f.revenue.currency, v)) : null;
  return sec('03', 'Business', null, kv([
    ['Location', loc || null],
    ['Industry', [b.vertical, b.subvertical, b.specialty].filter(Boolean).join(' · ') || null],
    ['Website', h('span', {}, site ? h('a', { class: 'mono', href: b.websiteUrl || `https://${b.domain}`, target: '_blank', rel: 'noopener noreferrer', text: site }) : null,
      h('span', { class: b.website.status === 'WEBSITE_NOT_OBSERVED' ? 'amberT' : 'muted', text: `${site ? ' · ' : ''}${WEBSITE_STATUS[b.website.status] ?? 'Not checked'}` }),
      b.website.checkedAt ? h('span', { class: 'muted', text: ` · checked ${date(b.website.checkedAt)}` }) : null)],
    ['Phone', b.phone ? h('span', { class: 'mono', text: b.phone }) : null],
    ['Listing', f.reviews.count !== null && f.reviews.rating !== null
      ? `${Number(f.reviews.rating)} ★ · ${f.reviews.count} reviews${f.reviews.source ? ` · ${humanize(f.reviews.source)}` : ''}${f.reviews.asOf ? `, ${date(f.reviews.asOf)}` : ''}` : null],
    ['Company', [word(COMPANY_TYPES, b.company.type), b.company.number, word(COMPANY_STATUSES, b.company.status)].filter(Boolean).join(' · ') || null],
    ['Employees', emp ? `${emp}${basis(f.employees)}` : null],
    ['Revenue', rev ? `${rev}${basis(f.revenue)}` : null],
    ['Source', b.sources.length ? b.sources.map((x) => `${humanize(x.provider || x.sourceType)} (${date(x.foundAt)})`).join(', ') : null],
  ]), companyWriter(cf, ctx), h('p', { class: 'hint', text: 'Estimated figures say so. Anything not known is left blank rather than guessed.' }));
}

// ---------------------------------------------------------------- 04 proposed service

function service(cf) {
  const s = cf.service;
  if (s.mappingStatus !== 'MAPPED') {
    return sec('04', 'Proposed service', null, h('div', { class: 'svc' }, h('div', {}, h('span', { class: 'eyebrow', text: 'Not mapped' }), h('b', { text: 'No service from your catalog yet' })),
      h('span', { class: 'unk', text: '' })), s.unmappedReason ? h('p', { class: 'hint', text: s.unmappedReason }) : null);
  }
  return sec('04', 'Proposed service', null,
    h('div', { class: 'svc' }, h('div', {}, h('span', { class: 'eyebrow', text: 'From your service catalog' }), h('b', { text: s.name })),
      s.price !== null ? h('span', { class: 'p', text: money(s.currency, s.price) }) : h('span', { class: 'unk', text: 'Price not set' })));
}

// ---------------------------------------------------------------- 05 build / fix

function build(cf) {
  const b = cf.build;
  const web = b.builder === 'website';
  const title = web ? 'Build website' : b.builder === 'fix' ? 'Build fix' : 'Build';
  const kids = [];
  if (b.builder === 'fix') {
    const st = b.fix?.steps ?? { problem: 'done', proof: 'current', capture: 'current' };
    kids.push(h('ol', { class: 'steps', 'aria-label': 'Fix progress' }, FIX_STEPS.map(([k, label]) => {
      const s = k === 'proof' ? (st.capture === 'done' ? 'done' : 'current') : st[k] ?? 'todo';
      return h('li', { class: s === 'done' ? 'done' : s === 'current' ? 'cur' : '' }, label);
    })));
  }
  if (b.projectId) {
    const c = b.current;
    kids.push(c ? h('div', { class: 'ver' }, h('b', { text: `Version ${c.versionNo}` }), h('span', { class: `badge ${c.status === 'DRAFT' ? 'b-rev' : 'b-obs'}`, text: (VERSION_WORD[c.status] ?? c.status).toUpperCase() }),
      h('span', { class: 'muted', text: c.shownAt ? `Shown ${date(c.shownAt)}` : c.approvedAt ? `Approved by ${c.approvedBy} ${date(c.approvedAt)}` : `Made ${date(c.createdAt)}` }),
      h('p', { class: 'hint', text: c.summary }))
      : h('p', { class: 'muted', text: b.builder === 'fix' ? (b.fix?.captured ? `Page captured ${when(b.fix.captured.capturedAt)}. The fix is not built yet.` : 'The page has not been captured yet.') : 'Nothing has been built yet.' }));
    kids.push(h('div', { class: 'row' },
      h('button', { class: `btn ${web ? 'amb' : 'primary'}`, onclick: () => go(web ? `#/p/${b.projectId}` : `#/f/${b.projectId}`) }, web ? 'Open Build Workspace' : 'Open Fix Builder'),
      h('span', { class: 'note', text: web ? 'Edit, preview, approve and show in the Website Build Workspace.' : 'Capture, correct, confirm and show in the Fix Builder.' })));
  } else if (b.canStart) {
    kids.push(h('div', { class: 'row' },
      h('button', { class: `btn ${web ? 'amb' : 'primary'}`, onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const r = await api('POST', `/opportunities/${cf.opportunityId}/${web ? 'website' : 'fix'}`);
          go(web ? `#/p/${r.projectId}/setup` : `#/f/${r.projectId}`);
        } catch (err) { fail(err); btn.disabled = false; }
      } }, title),
      h('span', { class: 'note', text: web ? 'Builds a private draft from the cited evidence and the business’s details.' : 'Captures a copy of the observed page first. The fix is built on the copy; the live site is never touched.' })));
  } else {
    kids.push(h('div', { class: 'note amber', text: b.blocker ?? 'Nothing can be built for this opportunity yet.' }));
  }
  return sec('05', title, null, ...kids);
}

// ---------------------------------------------------------------- 06 before / after / proof

function frame(src, title) {
  return h('iframe', { src, title, sandbox: '', loading: 'lazy', scrolling: 'no', tabindex: '-1' });
}

/** A desktop-width page shown whole inside a narrower box. */
function scaled(iframe, base = 1280, ratio = 0.62) {
  const box = h('div', { class: 'scaled' }, iframe);
  iframe.style.width = `${base}px`;
  iframe.style.height = `${Math.round(base * ratio)}px`;
  const fit = () => { const k = box.clientWidth / base; if (k > 0) { iframe.style.transform = `scale(${k})`; box.style.height = `${Math.round(base * ratio * k)}px`; } };
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(box);
  requestAnimationFrame(fit);
  return box;
}

function beforeAfter(cf) {
  const b = cf.build;
  const c = b.current;
  const s = sec('06', 'Before / After', null);
  if (!b.projectId || !c) {
    s.append(h('p', { class: 'unk', text: b.builder === 'fix' ? 'Not built yet. The before and after appear here once the fix is built.' : 'Not built yet. A preview appears here once the website is built.' }));
    return s;
  }
  if (b.builder === 'fix' && b.fix?.steps?.beforeAfter === 'todo') {
    s.append(h('p', { class: 'unk', text: 'Not built yet.' }));
    return s;
  }
  const slot = h('div', { class: 'baslot' }, h('div', { class: 'skeleton', style: 'height:220px' }));
  s.append(slot);
  const path = b.builder === 'fix' ? `/fix/${b.projectId}/versions/${c.buildId}/link` : `/projects/${b.projectId}/versions/${c.buildId}/link`;
  // An edit link is the seller's own short-lived view; it records nothing and is never shared.
  api('POST', path, { kind: 'edit' }).then((link) => {
    if (b.builder === 'fix') {
      const before = frame(link.before, 'Before: the page as captured');
      const after = frame(link.after, 'After: the corrected copy');
      const handle = h('span', { class: 'line' });
      const knob = h('span', { class: 'knob', text: '⇆' });
      const stage = h('div', { class: 'ba' }, h('div', { class: 'layers' }, before, after), handle, knob,
        h('span', { class: 'lab l', text: 'BEFORE · OBSERVED' }), h('span', { class: 'lab r', text: 'AFTER · PROPOSED' }));
      const range = h('input', { type: 'range', min: 0, max: 100, value: 50, 'aria-label': 'Compare before and after' });
      const place = (v) => { after.style.clipPath = `inset(0 0 0 ${v}%)`; handle.style.left = `${v}%`; knob.style.left = `${v}%`; };
      range.addEventListener('input', () => place(Number(range.value)));
      stage.append(range);
      place(50);
      slot.replaceChildren(stage,
        h('p', { class: 'hint', text: `Version ${c.versionNo}${b.fix?.correction ? ` · ${b.fix.correction.reads}` : ''}. Drag to compare. Both copies are shown without scripts or outside images.` }),
        b.fix?.captured ? kv([['Captured', h('span', { class: 'mono', text: when(b.fix.captured.capturedAt) })], ['From', h('span', { class: 'mono', text: b.fix.captured.finalUrl })]]) : null);
    } else {
      const site = cf.business.websiteUrl || cf.business.domain;
      slot.replaceChildren(
        h('div', { class: 'pair' },
          h('div', { class: 'today' }, h('span', { class: 'eyebrow', text: 'Today' }),
            h('p', {}, site ? h('span', { class: 'mono', text: site }) : null, `${site ? ' · ' : ''}Website ${(WEBSITE_STATUS[cf.business.website.status] ?? 'Not checked').toLowerCase()}`),
            h('p', { class: 'hint', text: 'Scopely does not keep a picture of the business’s current site.' })),
          h('div', { class: 'pv' }, h('span', { class: 'eyebrow amberT', text: `Built by Scopely · version ${c.versionNo}` }), h('div', { class: 'frame' }, scaled(frame(link.url, 'Website preview'))))),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: link.url, target: '_blank', rel: 'noopener' }, 'Open preview'),
          h('span', { class: 'note', text: 'A private view for you. It expires in 15 minutes.' })));
    }
  }).catch(() => slot.replaceChildren(h('p', { class: 'unk', text: 'The preview could not be loaded. Open the builder to see it.' })));
  return s;
}

// ---------------------------------------------------------------- 07 buyer / outreach preparation

/** Adds a contact the seller has, or corrects one (Slice 9). Only what they typed; nothing is looked up. */
function contactWriter(cf, ctx, c) {
  const name = input('Name', c?.name, { maxlength: 120, autocomplete: 'off' });
  const role = input('Role', c?.role, { maxlength: 120 });
  const dm = h('input', { type: 'checkbox', checked: Boolean(c?.isDecisionMaker), 'aria-label': 'Decision maker' });
  const email = h('input', { type: 'email', value: c?.email ?? '', maxlength: 254, autocomplete: 'off', 'aria-label': 'Email address' });
  const kind = select('Email kind', [['', 'Not known'], ['role', 'A role address (info@, bookings@)'], ['personal', 'A person’s own address']], c?.emailKind);
  const source = select('Source', [['', 'Choose…'], ...SOURCES, ...(c && !SOURCES.some(([k]) => k === c.source) ? [[c.source, humanize(c.source)]] : [])], c?.source);
  const sourceUrl = h('input', { type: 'url', value: c?.sourceUrl ?? '', maxlength: 500, placeholder: 'https://', 'aria-label': 'Source link' });
  const label = select('How sure', LABELS, c?.label ?? 'UNVERIFIED');
  const basis = select('Lawful basis', BASES, c?.outreachBasis ?? 'unknown');
  return writer(c ? 'Edit' : 'Add a contact', [
    field('Name', name), field('Role (optional)', role), h('label', { class: 'check' }, dm, h('span', { text: 'Decision maker' })),
    field('Email address', email), field('Email kind', kind), field('Where you got it', source), field('Source link (optional)', sourceUrl),
    field('How sure you are', label, 'Verified only when the business itself confirmed it.'),
    field('What lets you contact them', basis, 'In the UK, cold email to a company address needs an active Ltd or LLP; record the company status in 03.'),
  ], c ? 'Save' : 'Add contact', async () => {
    if (!name.value.trim() && !email.value.trim()) { name.focus(); toast('Enter a name or an email address.', { bad: true }); return false; }
    if (!source.value) { source.focus(); toast('Say where you got this contact.', { bad: true }); return false; }
    await api('POST', `/opportunities/${cf.opportunityId}/contacts${c ? `/${c.contactId}` : ''}`, {
      fullName: name.value, role: role.value, isDecisionMaker: dm.checked, email: email.value, emailKind: kind.value || null,
      source: source.value, sourceUrl: sourceUrl.value || null, label: label.value, outreachBasis: basis.value });
    return c ? 'Contact saved' : 'Contact added';
  }, ctx);
}

/** Puts an email address, the domain or the whole business on this workspace's suppression list (Slice 9). */
function suppressWriter(cf, ctx, target, contactId, summary) {
  const reason = select('Reason', REASONS, 'opt_out');
  return writer(summary, [field('Why', reason)], 'Stop contacting', async () => {
    await api('POST', `/opportunities/${cf.opportunityId}/suppressions`, { target, contactId: contactId ?? null, reason: reason.value });
    return 'Added to your suppression list';
  }, ctx, 'Suppression is permanent in this workspace and blocks outreach at once.');
}

function buyer(cf, ctx) {
  const s = sec('07', 'Buyer · outreach preparation', null);
  const contacts = cf.buyer.contacts;
  const r = cf.readiness;
  // The first thing still missing that is not about this contact: the evidence, or a whole-business suppression.
  const notYet = r.checks.find((x) => x.state !== 'done' && (x.key === 'evidence' || x.key === 'suppression'));
  s.append(h('div', { class: 'label', text: 'Who can buy it' }));
  if (!contacts.length) {
    s.append(h('p', { class: 'unk', text: 'No buyer identified yet. Scopely has no contact on record for this business.' }));
  } else {
    s.append(h('div', { class: 'contacts' }, contacts.map((c) => {
      const suppressed = cf.buyer.suppressions.some((x) => x.target === 'email' && c.email && x.value?.toLowerCase() === c.email.toLowerCase());
      return h('div', { class: 'contact' },
        h('div', { class: 'row' }, h('b', { text: c.name || 'Name not known' }), c.role ? h('span', { class: 'muted', text: c.role }) : null,
          c.isDecisionMaker ? h('span', { class: 'badge b-obs', text: 'DECISION MAKER' }) : null),
        c.email ? h('div', { class: 'row' }, h('span', { class: 'mono', text: c.email }), h('span', { class: `badge ${c.label === 'VERIFIED' ? 'b-obs' : 'b-rev'}`, text: LABEL[c.label] })) : null,
        h('p', { class: 'hint', text: `Source: ${word(SOURCES, c.source) === c.source ? humanize(c.source) : word(SOURCES, c.source)}${c.sourceUrl ? ` · ${c.sourceUrl}` : ''} · Outreach basis: ${BASIS[c.outreachBasis] ?? 'Not known'}` }),
        c.email ? (c.emailBlocker
          ? h('div', { class: 'note amber' }, h('b', { text: 'Do not email this contact. ' }), c.emailBlocker)
          : r.readyContactIds.includes(c.contactId)
            ? h('div', { class: 'row' },
              h('a', { class: 'btn sm', href: `mailto:${encodeURIComponent(c.email).replace('%40', '@')}` }, 'Write in your email app'),
              h('button', { class: 'btn sm', onclick: () => copy(c.email, 'Email address') }, 'Copy address'))
            : h('div', { class: 'note amber' }, h('b', { text: 'Not yet. ' }), notYet ? `${notYet.label}: ${notYet.detail ?? ''}` : 'This prospect is not ready.')) : null,
        h('div', { class: 'acts' }, contactWriter(cf, ctx, c),
          c.email && !suppressed && !cf.buyer.suppressions.some((x) => x.target === 'business') ? suppressWriter(cf, ctx, 'email', c.contactId, 'Stop contacting this address') : null));
    })));
  }
  s.append(contactWriter(cf, ctx, null));
  const phone = cf.business.phone;
  if (phone) {
    s.append(h('div', { class: 'contact' }, h('div', { class: 'row' }, h('b', { text: 'Business phone' }), h('span', { class: 'mono', text: phone })),
      h('p', { class: 'hint', text: 'The business’s public number, as its listing shows it.' }),
      h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `tel:${phone.replace(/[^\d+]/g, '')}` }, 'Call'), h('button', { class: 'btn sm', onclick: () => copy(phone, 'Phone number') }, 'Copy number'))));
  }

  // The facts a pitch can cite, from stored values only. Scopely does not write the message.
  const top = cf.evidence.find((e) => !cf.outreach.noLongerHolds.some((x) => x.evidenceId === e.evidenceId)) ?? null;
  const link = cf.build.showLink;
  const facts = [
    ['Observed', top ? top.plainIssue : null],
    ['Where', top ? top.url : null],
    ['When', top ? date(top.observedAt) : null],
    ['Service', cf.service.name],
    ['Price', cf.service.price !== null ? money(cf.service.currency, cf.service.price) : null],
    ['Preview', link ? abs(link.url) : null],
  ];
  s.append(h('div', { class: 'label', style: 'margin-top:6px', text: 'Facts to cite' }),
    kv(facts.map(([k, v]) => [k, v === null ? notKnown(k === 'Preview' ? 'No active preview link. Show a version from the builder to get one.' : k === 'Price' ? 'Price not set' : 'Not known') : k === 'Where' || k === 'Preview' ? h('span', { class: 'mono', text: v }) : v])),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => copy(facts.filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n'), 'Facts') }, 'Copy facts'),
      link ? h('span', { class: 'note', text: `Preview of version ${link.versionNo}, works until ${date(link.expiresAt)}.` }) : null));
  for (const r of cf.outreach.recheckNeeded) {
    s.append(h('div', { class: 'note amber' }, h('b', { text: 'Re-check before this reaches the business. ' }), `“${r.plainIssue}” is a high-confidence finding that has not been re-checked on a new visit.`));
  }
  for (const r of cf.outreach.noLongerHolds) {
    s.append(h('div', { class: 'note error' }, h('b', { text: 'Do not cite this. ' }), `“${r.plainIssue}” was ${r.result === 'gone' ? 'no longer there' : 'changed'} when re-checked.`));
  }
  s.append(h('div', { class: 'label', style: 'margin-top:6px', text: 'Suppression' }));
  const sup = cf.buyer.suppressions;
  if (sup.length) {
    s.append(h('ul', { class: 'supl' }, sup.map((x) => h('li', {},
      h('b', { text: x.target === 'business' ? 'This business' : x.target === 'domain' ? `Domain ${x.value}` : x.value }),
      h('span', { class: 'muted', text: ` · ${word(REASONS, x.reason)} · ${date(x.addedAt)}` })))));
  } else {
    s.append(h('p', { class: 'muted', text: 'Nothing about this business is on your suppression list.' }));
  }
  const whole = sup.some((x) => x.target === 'business');
  const domainOn = sup.some((x) => x.target === 'domain' && x.value?.toLowerCase() === (cf.business.domain ?? '').toLowerCase());
  s.append(h('div', { class: 'acts' }, whole ? null : suppressWriter(cf, ctx, 'business', null, 'Stop contacting this business'),
    cf.business.domain && !domainOn && !whole ? suppressWriter(cf, ctx, 'domain', null, `Stop contacting ${cf.business.domain}`) : null));
  s.append(h('p', { class: 'note', text: 'Scopely doesn’t send messages. Contact the business from your own inbox, phone or in person, then record what you did in 08.' }));
  return s;
}

// ---------------------------------------------------------------- 08 sell / outcome

function sell(cf, ctx) {
  const x = cf.sell;
  const s = sec('08', 'Sell · outcome', null);
  const lost = x.sellState === 'LOST';
  const order = ['NOT', 'PITCHED', 'REPLIED', 'WON'];
  const at = x.sellState === 'WON' || lost ? 3 : x.sellState === 'REPLIED' ? 2 : x.sellState === 'PITCHED' ? 1 : 0;
  s.append(h('ol', { class: 'steps sell', 'aria-label': 'Sell progress' }, order.map((k, i) => h('li', {
    class: lost && i === 3 ? 'lost' : i < at ? 'done' : i === at ? 'cur' : '' }, lost && i === 3 ? 'LOST' : k === 'NOT' ? 'NOT PITCHED' : k))));
  if (['DRAFTED', 'APPROVED', 'SENT'].includes(x.sellState)) {
    s.append(h('p', { class: 'hint', text: `A pitch message is ${x.sellState.toLowerCase()} in the message ledger. Record the pitch here once it has gone out.` }));
  }
  const calls = x.outcomes.filter((o) => o.kind === 'call').length;
  s.append(h('div', { class: 'out' },
    h('div', {}, h('span', { text: 'Pitched' }), h('b', { text: x.pitchedAt ? date(x.pitchedAt) : '—' })),
    h('div', {}, h('span', { text: 'Reply' }), h('b', { text: x.replyAt ? date(x.replyAt) : x.pitchedAt && !lost ? 'Waiting' : '—' })),
    h('div', {}, h('span', { text: 'Calls' }), h('b', { text: calls ? String(calls) : '—' })),
    h('div', {}, h('span', { text: 'Result' }), h('b', { class: x.sellState === 'WON' ? 'sageT' : '', text: x.sellState === 'WON' ? 'Won' : lost ? 'Lost' : 'Open' }))));
  if (x.sellState === 'WON') {
    s.append(h('div', { class: 'note sage' }, h('b', { text: `Agreed amount: ${x.agreedAmount !== null ? money(x.currency, x.agreedAmount) : 'not recorded'}. ` }),
      'Entered by you when you marked it won. Scopely has not recorded any payment.'));
  }
  if (x.outcomes.length) {
    s.append(h('div', { class: 'label', text: 'What happened' }), h('ol', { class: 'ledger' }, x.outcomes.map((o) => h('li', { class: o.voided ? 'voided' : '' },
      h('div', { class: 'row' }, h('b', { text: KIND_WORD[o.kind] ?? o.kind }), h('span', { class: 'mono', text: date(o.occurredAt) }),
        o.channel ? h('span', { class: 'muted', text: CHANNELS.find(([k]) => k === o.channel)?.[1] ?? o.channel }) : null,
        o.replyClass ? h('span', { class: 'muted', text: REPLIES.find(([k]) => k === o.replyClass)?.[1] ?? o.replyClass }) : null,
        o.amount !== null ? h('span', { text: `Agreed ${money(o.currency, o.amount)}` }) : null,
        o.voided ? h('span', { class: 'badge b-rev', text: 'CORRECTED' }) : null),
      o.notes ? h('p', { class: 'hint', text: o.notes }) : null,
      h('p', { class: 'hint', text: `Recorded by ${o.recordedBy}, ${when(o.recordedAt)}` })))));
  } else {
    s.append(h('p', { class: 'unk', text: 'Nothing recorded yet.' }));
  }
  s.append(recorder(cf, ctx));
  return s;
}

function recorder(cf, ctx) {
  const x = cf.sell;
  const kinds = [['pitched', 'Pitch'], ['replied', 'Reply'], ['call', 'Call'], ['won', 'Won'], ['lost', 'Lost'], ['voided', 'Correct']].filter(([k]) => x.can[k]);
  let kind = kinds[0][0];
  const fields = h('div', { class: 'recf' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What to record' });
  const drawSeg = () => seg.replaceChildren(...kinds.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === kind), onclick: () => { kind = k; drawSeg(); drawFields(); } }, label)));
  const on = h('input', { type: 'date', value: today(), max: today(), 'aria-label': 'Date' });
  const channel = h('select', { 'aria-label': 'Channel' }, h('option', { value: '' }, 'Choose…'), CHANNELS.map(([k, l]) => h('option', { value: k }, l)));
  const reply = h('select', { 'aria-label': 'Reply' }, h('option', { value: '' }, 'Choose…'), REPLIES.map(([k, l]) => h('option', { value: k }, l)));
  reply.addEventListener('change', () => drawFields());
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', 'aria-label': 'Agreed amount' });
  const currency = h('input', { type: 'text', maxlength: 3, placeholder: 'GBP', autocomplete: 'off', 'aria-label': 'Currency', value: x.currency ?? '', readonly: Boolean(x.currency) });
  const notes = h('textarea', { rows: 3, maxlength: 2000, 'aria-label': 'Notes' });
  const by = h('input', { type: 'text', value: remember('scopely.approver'), placeholder: 'Your name', maxlength: 120, autocomplete: 'name', 'aria-label': 'Recording as' });
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lab', text: label }), el, hint ? h('span', { class: 'hint', text: hint }) : null);
  const target = x.outcomes.find((o) => o.outcomeId === x.terminalOutcomeId);
  function drawFields() {
    const rows = [field(kind === 'voided' ? 'Date of the correction' : 'Date', on)];
    if (kind === 'pitched' || kind === 'replied' || kind === 'call') rows.push(field(kind === 'pitched' ? 'How you pitched' : 'Channel (optional)', channel));
    if (kind === 'replied') rows.push(field('What they said', reply, reply.value === 'opt_out' ? 'Recording this adds the business to your suppression list. Nothing more is needed.' : null));
    if (kind === 'won') {
      rows.push(h('div', { class: 'amt' }, field('Agreed amount', amount), field('Currency', currency, x.currency ? 'The opportunity’s currency.' : null)),
        h('p', { class: 'hint', text: 'The amount you agreed with the business. It is not a payment and Scopely does not invoice.' }));
    }
    if (kind === 'voided' && target) rows.push(h('p', { class: 'note', text: `Corrects “${KIND_WORD[target.kind]}” recorded ${date(target.occurredAt)}. The original stays in the record, marked as corrected.` }));
    rows.push(field(kind === 'voided' ? 'Why it was wrong' : 'Notes (optional)', notes), field('Recording as', by));
    fields.replaceChildren(...rows);
  }
  const save = h('button', { class: 'btn dark', onclick: async () => {
    if (!by.value.trim()) { by.focus(); toast('Say who is recording this.', { bad: true }); return; }
    remember('scopely.approver', by.value.trim());
    save.disabled = true;
    try {
      await api('POST', `/opportunities/${cf.opportunityId}/outcomes`, {
        kind, occurredOn: on.value, recordedBy: by.value.trim(), channel: channel.value || null, replyClass: reply.value || null,
        amount: kind === 'won' ? amount.value : null, currency: kind === 'won' ? currency.value : null, notes: notes.value || null,
        correctsOutcomeId: kind === 'voided' ? x.terminalOutcomeId : null,
      });
      toast(kind === 'replied' && reply.value === 'opt_out' ? 'Recorded. The business is now on your suppression list.' : 'Recorded');
      await refresh(ctx);
    } catch (err) { fail(err); save.disabled = false; }
  } }, 'Record');
  drawSeg(); drawFields();
  return h('div', { class: 'record' }, h('div', { class: 'label', text: 'Record what happened' }), seg, fields, h('div', { class: 'row' }, save,
    h('span', { class: 'note', text: 'Records are permanent. A mistake is corrected with a new record, never erased.' })));
}

// ---------------------------------------------------------------- 09 deliver, verify, get paid (planned)

function deliver(cf) {
  const top = cf.evidence[0];
  const row = (ok, n, title, sub) => h('li', {}, h('i', { class: ok ? 'ok' : '', text: ok ? '✓' : String(n) }), h('span', {}, title, h('br'), h('small', { text: sub })));
  return sec('09', 'Deliver · verify · get paid', { planned: true },
    h('ol', { class: 'chain' },
      row(Boolean(top), 1, 'Original evidence', top ? when(top.observedAt) : 'None linked'),
      row(false, 2, 'Solution delivered', 'After the work is won and delivered'),
      row(false, 3, 'New observation', 'Scopely re-checks the same page'),
      row(false, 4, 'Verified', 'The original problem is gone'),
      row(false, 5, 'Paid', 'Recorded when the business pays')),
    h('p', { class: 'hint', text: 'Planned. Scopely does not record delivery, verification or payment from here yet.' }));
}
