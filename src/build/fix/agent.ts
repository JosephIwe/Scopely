// The website_fix build kind through the Slice 4 roles:
//
//   websiteFixBuilder (FixBuilder, WHAT)  the fix kind's rules: repair only the observed broken
//                                         destination, only with a value a person supplied.
//   ScopelyFixAgent (BuildAgent, HOW)     reads the page captured into its own project (F2), replaces
//                                         the observed destination in the matching links with the
//                                         person's corrected value, and writes the corrected copy,
//                                         the fix document and the prospect's preview into its run
//                                         prefix. Deterministic: it uses no model.
//
// The agent never sees a database handle. It trusts nothing in the run's parameters that it can
// check: each correction must answer evidence that still holds in the BuildContext, have the
// shape of its channel, and match at least one link on the captured page, whose bytes must match
// their recorded hash.
import type { BuildAgent, BuildAgentResult, BuildAgentTask, BuildInstructions } from '../agents.js';
import type { FixBuilder } from '../index.js';
import { BuildRunError } from '../runs.js';
import { type Channel, CHANNELS_FOR, isValidHref } from './destination.js';
import { FIX_SCHEMA, type FixCorrectionApplied, type FixDocument } from './document.js';
import { linkContext, pageText, replaceLinks } from './page.js';
import { renderFixPreview } from './render.js';

export const FIX_KIND = 'website_fix';
export const FIX_AGENT_KEY = 'scopely_fix';

export const websiteFixBuilder: FixBuilder = {
  kind: FIX_KIND,
  version: '1',
  instruct: async (ctx): Promise<BuildInstructions> => ({
    buildKind: ctx.project.buildKind,
    purpose: ctx.purpose,
    objective: `Repair the observed broken contact link on ${ctx.business.name}'s page, on a copy of the captured page`,
    tasks: ctx.evidence.filter((e) => CHANNELS_FOR[e.issueCode]).map((e) => ({ title: `Correct the destination of: ${e.plainIssue}`, addressesEvidenceIds: [e.evidenceId] })),
    constraints: [
      'Change only the href of links whose destination is the observed broken one',
      'Use only a corrected destination a person supplied; never derive or invent one',
      'Keep every other byte of the captured page',
    ],
    mustNotClaim: [...ctx.withheldFacts.map((w) => w.attribute), ...ctx.notObservable.map((o) => o.checkCode)],
  }),
};

/** One correction as the run carries it. */
export interface FixRunCorrection { correctionId: string; evidenceId: string; channel: Channel; observedHref: string; correctedHref: string }

/** The run's parameters (build_runs.meta). */
export interface FixRunMeta {
  capture: { captureId: string; ref: string; sha256: string; contentType: string; finalUrl: string; capturedAt: string };
  corrections: FixRunCorrection[];
}

export class ScopelyFixAgent implements BuildAgent {
  readonly key = FIX_AGENT_KEY;
  readonly version = '1';
  readonly modelUse = 'NONE' as const;

  async run(task: BuildAgentTask): Promise<BuildAgentResult> {
    const files = task.project.files;
    if (!files) throw new BuildRunError('NO_STORAGE', 'the fix agent needs project storage');
    const ctx = task.context;
    const meta = task.meta as unknown as FixRunMeta;
    const cap = meta?.capture;
    if (!cap || typeof cap.ref !== 'string' || !Array.isArray(meta.corrections) || meta.corrections.length === 0) {
      throw new BuildRunError('NO_CORRECTION', 'a fix run needs a capture and at least one corrected value');
    }
    // The capture must be this project's own, under captures/, and exactly the bytes recorded.
    if (!cap.ref.startsWith(`${ctx.project.storagePrefix}captures/`)) throw new BuildRunError('CAPTURE_UNVERIFIED', 'the capture is not this project\'s');
    let captured;
    try {
      captured = await files.readVerified(cap.ref, cap.sha256);
    } catch {
      throw new BuildRunError('CAPTURE_UNVERIFIED', 'the captured page does not match its recorded hash');
    }

    // Byte-preserving: one character per byte, so every byte the correction does not touch is kept.
    let page = captured.bytes.toString('latin1');
    const readable = pageText(captured.bytes, cap.contentType);
    const applied: FixCorrectionApplied[] = [];
    const problems: FixDocument['problems'] = [];
    for (const c of meta.corrections) {
      const ev = ctx.evidence.find((e) => e.evidenceId === String(c.evidenceId));
      const allowed = ev ? CHANNELS_FOR[ev.issueCode] : undefined;
      if (!ev || !allowed || !allowed.includes(c.channel) || !isValidHref(c.channel, c.correctedHref) || c.correctedHref === c.observedHref) {
        throw new BuildRunError('CORRECTION_UNSUPPORTED', 'a corrected value does not answer evidence that holds');
      }
      const context = linkContext(readable, c.observedHref);
      const out = replaceLinks(page, c.observedHref, c.correctedHref);
      if (out.replaced === 0) throw new BuildRunError('LINK_NOT_ON_PAGE', 'the observed link is not on the captured page');
      page = out.html;
      applied.push({ correctionId: String(c.correctionId), evidenceId: ev.evidenceId, channel: c.channel, observedHref: c.observedHref, correctedHref: c.correctedHref,
        replaced: out.replaced, label: context?.label ?? null, context: context ? { before: context.before, after: context.after } : null });
      problems.push({ evidenceId: ev.evidenceId, issueCode: ev.issueCode, plainIssue: ev.plainIssue, quote: ev.quote, url: ev.url, observedAt: ev.observedAt, confidence: ev.confidence });
    }

    const after = await files.write('after.html', Buffer.from(page, 'latin1'), captured.contentType);
    const doc: FixDocument = {
      schema: FIX_SCHEMA,
      business: { name: ctx.business.name, domain: ctx.business.domain },
      page: { url: problems[0]!.url, finalUrl: cap.finalUrl, capturedAt: cap.capturedAt },
      problems,
      capture: { captureId: String(cap.captureId), ref: cap.ref, sha256: cap.sha256, contentType: captured.contentType },
      corrections: applied,
      after: { ref: after.key, sha256: after.sha256 },
    };
    const manifest = await files.write('fix.json', Buffer.from(JSON.stringify(doc)), 'application/json');
    const preview = await files.write('index.html', Buffer.from(renderFixPreview(doc)), 'text/html; charset=utf-8');
    const n = applied.reduce((s, a) => s + a.replaced, 0);
    return {
      title: `Contact link fix for ${ctx.business.name}`.slice(0, 120),
      summary: `Corrected ${n === 1 ? 'one link' : `${n} links`} on a copy of the captured page: ${applied.map((a) => `${a.observedHref} → ${a.correctedHref}`).join('; ')}`.slice(0, 600),
      manifestRef: manifest.key, manifestSha256: manifest.sha256,
      previewRef: preview.key, previewSha256: preview.sha256,
      usage: [],
    };
  }
}
