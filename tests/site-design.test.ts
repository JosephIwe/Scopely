// Slice 6: Meridian 2 ("Modern Clinic"). Sites built with Meridian 1 keep rendering to the same
// bytes; a new version made from one is upgraded to Meridian 2; the new style controls go through
// the same strict operations; Undo restores the previous version as a new version; the site stays
// one self-contained file.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BuildContext } from '../src/build/context.js';
import {
  EditRejected, MERIDIAN, MERIDIAN_V1, applyEdits, assertValidDocument, describeChanges, generateDocument, getSiteWorkspace, parseOperation, renderSite,
  generateSite, openWebsiteProject, requestAiEdit, restoreVersion, saveEdits, upgradeDocument, verifyVersionArtifact, websiteBuilder, ARTIFACT_HEADERS,
} from '../src/build/site/index.js';
import { MemoryObjectStore } from '../src/storage/index.js';
import { one, useDb } from './helpers.js';
import { seedWebsiteOpportunity } from './site-helpers.js';

// Lets one test build a site with Meridian 1, as Slice 5 did, without adding a way to do that to the product.
const legacy = vi.hoisted(() => ({ on: false }));
vi.mock('../src/build/site/template.js', async (orig) => {
  const m = await orig<typeof import('../src/build/site/template.js')>();
  return { ...m, getTemplate: (key: string, version?: number) => (legacy.on && version === undefined ? m.MERIDIAN_V1 : m.getTemplate(key, version)) };
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function context(): BuildContext {
  return {
    contextVersion: 1, purpose: 'DEMO',
    project: { projectId: '7', buildKind: 'website', opportunityPath: 'WEBSITE', storagePrefix: 'workspaces/1/projects/7/' },
    baseVersion: null,
    business: { businessId: '3', name: 'Northside Studio', domain: 'northside.test', websiteUrl: 'https://northside.test/', identitySources: [] },
    facts: [{ attribute: 'reviews', value: { rating: 4.7, count: 132, source: 'google_places' }, source: 'google_places', basis: 'observed',
      recordedAt: '2026-09-20T10:00:00.000Z', factId: '1' }] as unknown as BuildContext['facts'],
    withheldFacts: [],
    opportunity: { opportunityId: '11', opportunityType: 'website_rebuild', kind: 'website' },
    catalogItem: { catalogItemId: '5', catalogKey: 'website_build', service: 'Website build', components: [] },
    evidence: [{ evidenceId: '21', issueCode: 'E-BOOK-TO-ENQUIRY', plainIssue: 'The Book button opens a general enquiry form', url: 'https://northside.test/',
      quote: '<a href="/contact">Book now</a>', observedAt: '2026-09-28T10:00:00.000Z', confidence: 'HIGH', claimState: 'OBSERVED', recheck: null }],
    notObservable: [], notObservableNotes: null, requirements: [], assets: [{ assetId: '41', kind: 'image' }] as unknown as BuildContext['assets'],
  };
}

// The same edits the Slice 5 code was given to produce the golden hashes below.
const V1_OPS = [
  { op: 'update_items', section: 'services', slot: 'items', items: [{ title: 'Consultations', text: 'A first conversation.' }, { title: 'Follow-ups', text: '' }] },
  { op: 'update_cta', label: 'Call us', action: { kind: 'phone', value: '+442079460000' } },
  { op: 'change_color', palette: 'clay' },
  { op: 'change_layout', section: 'hero', variant: 'banner' },
  { op: 'update_text', section: 'about', slot: 'body', value: 'A small studio.\n\nOpen weekdays.' },
];
const images = new Map([['41', { contentType: 'image/png' as const, bytes: PNG, alt: 'Room' }]]);

async function v1Document() {
  const ctx = context();
  const base = generateDocument(ctx, await websiteBuilder.instruct!(ctx), MERIDIAN_V1);
  return applyEdits(base, V1_OPS, { template: MERIDIAN_V1, imageAssetIds: new Set(['41']), origin: 'person' }).document;
}

async function v2Document() {
  const ctx = context();
  return generateDocument(ctx, await websiteBuilder.instruct!(ctx), MERIDIAN);
}

describe('Meridian 1 is frozen', () => {
  it('renders a Meridian 1 document to exactly the bytes Slice 5 produced', async () => {
    const d = await v1Document();
    expect(d.schema).toBe('scopely.site/1');
    // Hashes of main@1b40efc's renderer on this document.
    expect(sha(renderSite(d, MERIDIAN_V1, images, { mode: 'artifact' }))).toBe('360e6e801225a17e8f03c36fbc9a95484e4e14275ef0e4e1b2d7693d11dfa258');
    expect(sha(renderSite(d, MERIDIAN_V1, images, { mode: 'editor', selected: 'services' }))).toBe('a799a906b592c77dbeae3a42f95bf8009e0ac0a461285d2bf98b0b5eefac16fa');
  });

  it('keeps each template version\'s rules: Meridian 1 has no style controls and Meridian 2 has no banner hero', async () => {
    const v1 = await v1Document();
    expect(() => applyEdits(v1, [{ op: 'change_style', button: 'square' }], { template: MERIDIAN_V1, imageAssetIds: new Set(), origin: 'person' })).toThrow(EditRejected);
    const v2 = await v2Document();
    expect(() => applyEdits(v2, [{ op: 'change_layout', section: 'hero', variant: 'banner' }], { template: MERIDIAN, imageAssetIds: new Set(), origin: 'person' })).toThrow(EditRejected);
    expect(() => assertValidDocument({ ...v2, schema: 'scopely.site/1' }, MERIDIAN)).toThrow();
    expect(() => assertValidDocument({ ...v1, theme: { ...v1.theme, button: 'pill' } }, MERIDIAN_V1)).toThrow();
  });
});

describe('upgrading a Meridian 1 document', () => {
  it('keeps what people wrote, maps the look to the nearest choice and adds the call-to-action band', async () => {
    const v1 = await v1Document();
    const before = JSON.stringify(v1);
    const up = upgradeDocument(v1);
    expect(JSON.stringify(v1)).toBe(before); // the stored document is never rewritten
    expect(up).toMatchObject({ schema: 'scopely.site/2', template: { templateKey: 'meridian', version: 2 } });
    expect(up.theme).toEqual({ palette: 'blush', fonts: 'modern', accent: null, button: 'pill', spacing: 'comfortable', image: 'soft', backgrounds: 'alternate' });
    expect(up.sections.find((s) => s.type === 'hero')!.variant).toBe('centered');
    expect(up.sections.map((s) => s.type)).toEqual(['hero', 'services', 'about', 'proof', 'gallery', 'cta', 'contact', 'footer']);
    expect(up.cta).toEqual(v1.cta);
    expect(up.sections.find((s) => s.type === 'services')!.content).toEqual(v1.sections.find((s) => s.type === 'services')!.content);
    expect(up.basis).toEqual(v1.basis);
    assertValidDocument(up, MERIDIAN);
    expect(upgradeDocument(up)).toBe(up);
  });
});

describe('style controls', () => {
  it('parses change_style strictly', () => {
    expect(parseOperation({ op: 'change_style', button: 'square', spacing: 'airy' })).toEqual({ op: 'change_style', button: 'square', spacing: 'airy' });
    for (const bad of [{ op: 'change_style' }, { op: 'change_style', button: 'square', colour: 'red' }, { op: 'change_style', button: 3 }]) {
      expect(() => parseOperation(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('applies a known choice and refuses anything else', async () => {
    const d = await v2Document();
    const env = { template: MERIDIAN, imageAssetIds: new Set<string>(), origin: 'person' as const };
    const { document } = applyEdits(d, [{ op: 'change_style', button: 'square', image: 'arch', spacing: 'airy', backgrounds: 'plain' }], env);
    expect(document.theme).toMatchObject({ button: 'square', image: 'arch', spacing: 'airy', backgrounds: 'plain' });
    const html = renderSite(document, MERIDIAN, images, { mode: 'artifact' });
    expect(html).not.toContain('class="sec tint"');
    expect(() => applyEdits(d, [{ op: 'change_style', button: 'round;}</style><script>' }], env)).toThrow(EditRejected);
  });

  it('describes what changed in words a person reads', async () => {
    const d = await v2Document();
    const env = { template: MERIDIAN, imageAssetIds: new Set<string>(), origin: 'person' as const };
    const { document } = applyEdits(d, [
      { op: 'change_color', palette: 'sage' }, { op: 'change_style', spacing: 'airy' }, { op: 'hide_section', section: 'gallery' },
      { op: 'update_text', section: 'hero', slot: 'headline', value: 'Northside Studio, Leeds' }, { op: 'move_section', section: 'proof', direction: 'up' },
    ], env);
    const rows = describeChanges(d, document, MERIDIAN);
    expect(rows).toEqual(expect.arrayContaining([
      { section: 'page', label: 'Colours', from: 'Stone', to: 'Sage' },
      { section: 'page', label: 'Spacing', from: 'Comfortable', to: 'Airy' },
      { section: 'hero', label: 'Hero · headline', from: 'Northside Studio', to: 'Northside Studio, Leeds' },
      expect.objectContaining({ section: 'page', label: 'Section order' }),
    ]));
    expect(describeChanges(d, d, MERIDIAN)).toEqual([]);
  });
});

describe('a self-contained site', () => {
  it('embeds its typefaces and makes no outside request', async () => {
    const html = renderSite(await v2Document(), MERIDIAN, images, { mode: 'artifact' });
    expect(html).toMatch(/@font-face\{font-family:"Instrument Serif";[^}]*src:url\(data:font\/woff2;base64,/);
    expect(html).toMatch(/@font-face\{font-family:"Geist";/);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\/(?!wa\.me)/);
    expect(html).not.toMatch(/url\((https?:)?\/\//);
    expect(ARTIFACT_HEADERS['content-security-policy']).toMatch(/font-src data:/);
    expect(ARTIFACT_HEADERS['content-security-policy']).toMatch(/default-src 'none'/);
  });
});

// ------------------------------------------------------------------ with a database

const { db } = useDb();

async function doc(store: MemoryObjectStore, projectId: string) {
  return (await getSiteWorkspace(db(), store, projectId)).current!.document;
}

describe('a site built with Meridian 1', () => {
  it('keeps its stored version and makes its next version with Meridian 2', async () => {
    const store = new MemoryObjectStore();
    const seed = await seedWebsiteOpportunity(db());
    const projectId = await openWebsiteProject(db(), seed.opportunityId);
    legacy.on = true;
    let run;
    try { run = await generateSite(db(), { store }, projectId, { templateKey: 'meridian' }); } finally { legacy.on = false; }
    expect(run.status).toBe('SUCCEEDED');
    const v1 = run.buildId!;
    const before = new Map([...store.objects].map(([k, o]) => [k, o.bytes.toString('base64')]));

    const ws = await getSiteWorkspace(db(), store, projectId);
    expect(ws.current!.upgraded).toBe(true);
    expect(ws.current!.document.template.version).toBe(2);

    const { buildId: v2 } = await saveEdits(db(), store, projectId, { baseBuildId: v1, operations: [{ op: 'change_style', button: 'square' }] });
    expect((await one<{ generator: string }>(db(), 'SELECT generator FROM builds WHERE id = $1', [v2])).generator).toBe('editor:meridian@2');
    expect((await doc(store, projectId)).template.version).toBe(2);
    // Nothing stored for version 1 changed, and it still verifies.
    for (const [k, b64] of before) expect(store.objects.get(k)!.bytes.toString('base64')).toBe(b64);
    expect(await verifyVersionArtifact(db(), store, projectId, v1)).toBe(true);
    expect(await verifyVersionArtifact(db(), store, projectId, v2)).toBe(true);
  });
});

describe('undo', () => {
  async function built() {
    const store = new MemoryObjectStore();
    const seed = await seedWebsiteOpportunity(db());
    const projectId = await openWebsiteProject(db(), seed.opportunityId);
    const run = await generateSite(db(), { store }, projectId, { templateKey: 'meridian' });
    return { store, projectId, v1: run.buildId! };
  }

  it('restores the previous version as a new version and deletes nothing', async () => {
    const { store, projectId, v1 } = await built();
    const r = await requestAiEdit(db(), { store }, projectId, { baseBuildId: v1, request: 'Use a classic serif' });
    expect(r.status).toBe('SUCCEEDED');
    const v2 = r.buildId!;
    const changes = (await doc(store, projectId)).lastEdit.changes;
    expect(changes).toEqual([{ section: 'page', label: 'Type', from: 'Editorial', to: 'Classic' }]);

    const u = await restoreVersion(db(), store, projectId, { baseBuildId: v2, fromBuildId: v1, undo: true });
    expect(u.versionNo).toBe(3);
    const rows = (await db().query('SELECT version_no, status, supersedes_build_id FROM builds WHERE project_id = $1 ORDER BY version_no', [projectId])).rows;
    expect(rows).toEqual([
      { version_no: 1, status: 'SUPERSEDED', supersedes_build_id: null },
      { version_no: 2, status: 'SUPERSEDED', supersedes_build_id: v1 },
      { version_no: 3, status: 'DRAFT', supersedes_build_id: v2 },
    ]);
    const d = await doc(store, projectId);
    expect(d.theme.fonts).toBe('editorial');
    expect(d.lastEdit.applied).toEqual(['Undid version 2: restored version 1']);
    for (const id of [v1, v2, u.buildId]) expect(await verifyVersionArtifact(db(), store, projectId, id)).toBe(true);
  });

  it('only undoes the latest change', async () => {
    const { store, projectId, v1 } = await built();
    const { buildId: v2 } = await saveEdits(db(), store, projectId, { baseBuildId: v1, operations: [{ op: 'change_color', palette: 'sage' }] });
    const { buildId: v3 } = await saveEdits(db(), store, projectId, { baseBuildId: v2, operations: [{ op: 'change_color', palette: 'blush' }] });
    await expect(restoreVersion(db(), store, projectId, { baseBuildId: v3, fromBuildId: v1, undo: true })).rejects.toThrow(/Only the latest change/);
    await expect(restoreVersion(db(), store, projectId, { baseBuildId: v2, fromBuildId: v1, undo: true })).rejects.toThrow(/newer version exists/);
    // Restoring any earlier version from the history still works.
    expect((await restoreVersion(db(), store, projectId, { baseBuildId: v3, fromBuildId: v1 })).versionNo).toBe(4);
  });
});
