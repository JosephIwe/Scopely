// The website build kind, end to end through the PR4 roles:
//
//   websiteBuilder (FixBuilder, WHAT)   the website kind's rules: which evidence each change answers
//                                       and what the site must not claim.
//   ScopelySiteAgent (BuildAgent, HOW)  generates a version from a template, or applies an AI edit
//                                       to the version the run modifies; renders it; writes the site
//                                       document and preview into the run's own storage prefix.
//   EditInterpreter (interpret.ts)      turns an edit request into operations. The deterministic one
//                                       uses no model; a model-backed one would take the ModelProvider
//                                       the executor opens from the run's connection.
//
// The agent never sees a database handle, a credential or another project's files. It returns
// references and hashes; the executor verifies them and records a DRAFT version.
import type { BuildAgent, BuildAgentResult, BuildAgentTask, BuildInstructions, ModelProvider } from '../agents.js';
import type { FixBuilder } from '../index.js';
import { BuildRunError } from '../runs.js';
import { type SiteDocument, generateDocument, planChanges, upgradeDocument } from './document.js';
import { loadPlacedImages } from './images.js';
import type { EditInterpreter } from './interpret.js';
import { EditRejected, applyEdits, assertValidDocument, describeChanges, describeOperation } from './operations.js';
import { renderSite } from './render.js';
import { getTemplate } from './template.js';

export const WEBSITE_KIND = 'website';

export const websiteBuilder: FixBuilder = {
  kind: WEBSITE_KIND,
  version: '1',
  instruct: async (ctx): Promise<BuildInstructions> => ({
    buildKind: ctx.project.buildKind,
    purpose: ctx.purpose,
    objective: `A website for ${ctx.business.name} that answers what was observed, built from a template and stating only sourced facts`,
    tasks: planChanges(ctx).map((c) => ({ title: c.change, addressesEvidenceIds: c.evidenceIds })),
    constraints: [
      'Use only the business name, supplied images and sourced facts; leave every other slot for a person',
      'Never turn a finding into public copy',
      'Never supply a contact detail; a person adds it',
    ],
    mustNotClaim: [
      ...ctx.withheldFacts.map((w) => w.attribute),
      ...ctx.notObservable.map((o) => o.checkCode),
    ],
  }),
};

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class ScopelySiteAgent implements BuildAgent {
  readonly key = 'scopely_site';
  readonly version = '1';
  readonly modelUse: BuildAgent['modelUse'];

  constructor(private readonly interpreter: EditInterpreter) {
    this.modelUse = interpreter.modelUse === 'NONE' ? 'NONE' : 'PROVIDER_CONNECTION';
  }

  async run(task: BuildAgentTask, model: ModelProvider | null): Promise<BuildAgentResult> {
    const files = task.project.files;
    if (!files) throw new BuildRunError('NO_STORAGE', 'the site agent needs project storage');
    const ctx = task.context;
    const assets = ctx.assets.filter((a) => a.kind === 'image');
    let doc: SiteDocument;
    let summary: string;

    if (!ctx.baseVersion) {
      const key = typeof task.meta.template === 'string' ? task.meta.template : '';
      let t;
      try { t = getTemplate(key); } catch { throw new BuildRunError('TEMPLATE_NOT_FOUND', 'unknown template'); }
      doc = generateDocument(ctx, task.instructions, t);
      summary = cap(`Built from the ${t.name} template. ${doc.basis.addresses.map((a) => a.change).join('. ')}.`, 600);
    } else {
      const base = ctx.baseVersion;
      if (!base.manifestRef) throw new BuildRunError('BASE_NOT_EDITABLE', 'the base version has no site document');
      const stored = JSON.parse((await files.readVerified(base.manifestRef, base.manifestSha256)).bytes.toString('utf8')) as SiteDocument;
      assertValidDocument(stored, getTemplate(stored.template?.templateKey, stored.template?.version));
      // The new version is made with the current template; the stored one is never rewritten.
      const raw = upgradeDocument(stored);
      const t = getTemplate(raw.template.templateKey, raw.template.version);
      const request = typeof task.meta.request === 'string' ? task.meta.request : '';
      if (!request.trim()) throw new BuildRunError('EDIT_REQUEST_EMPTY', 'no edit request');
      const interpretation = await this.interpreter.interpret({ request, document: raw, template: t, context: ctx }, model);
      if (interpretation.operations.length === 0 && interpretation.needsInput.length === 0) {
        throw new BuildRunError('EDIT_NOT_UNDERSTOOD', 'the request did not map to any edit');
      }
      let applied;
      try {
        ({ document: doc, applied } = applyEdits(raw, interpretation.operations, {
          template: t, origin: 'ai', requestText: request, imageAssetIds: new Set(assets.map((a) => a.assetId)) }));
      } catch (err) {
        if (err instanceof EditRejected) throw new BuildRunError('EDIT_REFUSED', err.message);
        throw err;
      }
      const lines = applied.map((op) => describeOperation(op, t));
      doc.lastEdit = { by: 'ai', request: cap(request.trim(), 500), applied: lines, needsInput: interpretation.needsInput, changes: describeChanges(raw, doc, t) };
      summary = cap(`AI edit: ${lines.join('; ') || 'no change yet'}${interpretation.needsInput.length ? `. Needs you: ${interpretation.needsInput.join(' ')}` : ''}`, 600);
    }

    const t = getTemplate(doc.template.templateKey, doc.template.version);
    const images = await loadPlacedImages(files, assets, doc);
    const html = renderSite(doc, t, images, { mode: 'artifact' });
    const manifest = await files.write('site.json', Buffer.from(JSON.stringify(doc)), 'application/json');
    const preview = await files.write('index.html', Buffer.from(html), 'text/html; charset=utf-8');
    return {
      title: cap(`${doc.brand.name} website`, 120),
      summary,
      manifestRef: manifest.key, manifestSha256: manifest.sha256,
      previewRef: preview.key, previewSha256: preview.sha256,
      // A deterministic agent calls no model, so it reports no usage and nothing is metered.
      usage: [],
    };
  }
}
