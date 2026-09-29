// The Case File (Slice 8): one opportunity, organised the way the seller works it.
//   What is the opportunity? Why do we believe it? What can we build or fix? Who can buy it?
//   What did the seller do? What happened?
// It shows what the server returned and nothing else: an unknown value reads as not known, a
// later stage reads as planned, and nothing on this page sends anything to anyone (U4). The
// builders open unchanged from section 05.
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
        h('h2', { class: 'bizName', text: cf.business.name })),
      situation(cf, top), evidence(cf), business(cf), service(cf), build(cf), beforeAfter(cf), buyer(cf), sell(cf, ctx), deliver(cf)));
  return root;
}

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

function evidence(cf) {
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
      h('details', { class: 'raw' }, h('summary', { text: 'Show evidence' }), h('pre', { class: 'mono', text: e.quote })));
  });
  return sec('02', cf.path === 'FIX' ? 'Evidence · proof' : 'Evidence', null, ...items,
    h('p', { class: 'hint', text: 'Observed means Scopely saw it on the page. Inferred claims are never presented as observed.' }));
}

// ---------------------------------------------------------------- 03 business

function business(cf) {
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
    ['Company', [b.company.type, b.company.number, b.company.status].filter(Boolean).join(' · ') || null],
    ['Employees', emp ? `${emp}${basis(f.employees)}` : null],
    ['Revenue', rev ? `${rev}${basis(f.revenue)}` : null],
    ['Source', b.sources.length ? b.sources.map((x) => `${humanize(x.provider || x.sourceType)} (${date(x.foundAt)})`).join(', ') : null],
  ]), h('p', { class: 'hint', text: 'Estimated figures say so. Anything not known is left blank rather than guessed.' }));
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

function buyer(cf) {
  const s = sec('07', 'Buyer · outreach preparation', null);
  const contacts = cf.buyer.contacts;
  s.append(h('div', { class: 'label', text: 'Who can buy it' }));
  if (!contacts.length) {
    s.append(h('p', { class: 'unk', text: 'No buyer identified yet. Scopely has no contact on record for this business.' }));
  } else {
    s.append(h('div', { class: 'contacts' }, contacts.map((c) => h('div', { class: 'contact' },
      h('div', { class: 'row' }, h('b', { text: c.name || 'Name not known' }), c.role ? h('span', { class: 'muted', text: c.role }) : null,
        c.isDecisionMaker ? h('span', { class: 'badge b-obs', text: 'DECISION MAKER' }) : null),
      c.email ? h('div', { class: 'row' }, h('span', { class: 'mono', text: c.email }), h('span', { class: `badge ${c.label === 'VERIFIED' ? 'b-obs' : 'b-rev'}`, text: LABEL[c.label] })) : null,
      h('p', { class: 'hint', text: `Source: ${humanize(c.source)}${c.sourceUrl ? ` · ${c.sourceUrl}` : ''} · Outreach basis: ${BASIS[c.outreachBasis] ?? 'Not known'}` }),
      c.email ? (c.emailBlocker
        ? h('div', { class: 'note amber' }, h('b', { text: 'Do not email this contact. ' }), c.emailBlocker)
        : h('div', { class: 'row' },
          h('a', { class: 'btn sm', href: `mailto:${encodeURIComponent(c.email).replace('%40', '@')}` }, 'Write in your email app'),
          h('button', { class: 'btn sm', onclick: () => copy(c.email, 'Email address') }, 'Copy address'))) : null))));
  }
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
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', 'aria-label': 'Agreed amount' });
  const currency = h('input', { type: 'text', maxlength: 3, placeholder: 'GBP', autocomplete: 'off', 'aria-label': 'Currency', value: x.currency ?? '', readonly: Boolean(x.currency) });
  const notes = h('textarea', { rows: 3, maxlength: 2000, 'aria-label': 'Notes' });
  const by = h('input', { type: 'text', value: remember('scopely.approver'), placeholder: 'Your name', maxlength: 120, autocomplete: 'name', 'aria-label': 'Recording as' });
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'lab', text: label }), el, hint ? h('span', { class: 'hint', text: hint }) : null);
  const target = x.outcomes.find((o) => o.outcomeId === x.terminalOutcomeId);
  function drawFields() {
    const rows = [field(kind === 'voided' ? 'Date of the correction' : 'Date', on)];
    if (kind === 'pitched' || kind === 'replied' || kind === 'call') rows.push(field(kind === 'pitched' ? 'How you pitched' : 'Channel (optional)', channel));
    if (kind === 'replied') rows.push(field('What they said', reply));
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
      toast('Recorded');
      await ctx.reload();
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
