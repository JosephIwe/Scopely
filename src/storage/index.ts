// Project object storage. One abstraction, one namespace:
//
//   workspaces/<workspace>/projects/<project>/versions/...   a version's site document and preview
//   workspaces/<workspace>/projects/<project>/assets/...     files the seller or client supplied
//
// Objects are write-once: a key that exists is never overwritten, so a stored version's files are
// immutable by construction. Keys follow the same rule the database applies to manifest_ref and
// storage_ref (project_storage_blocker), and a ProjectFiles handle refuses any key outside its own
// project, so code holding a handle cannot read or write another project's or workspace's files.
//
// Storage is not a URL space. Nothing here is served directly: previews are served only through a
// signed, short-lived link that is checked against the database and the recorded hash
// (src/build/site/preview.ts).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const KEY = /^workspaces\/[0-9]+\/projects\/[0-9]+\/[A-Za-z0-9._/-]+$/;

/** Throws unless `key` is a well-formed project storage key with no traversal. */
export function assertStorageKey(key: string): void {
  if (!KEY.test(key) || /(^|\/)\.\.?(\/|$)/.test(key) || key.includes('//')) {
    throw new Error('not a project storage key');
  }
}

export const projectPrefix = (workspaceId: string, projectId: string): string => {
  if (!/^\d+$/.test(workspaceId) || !/^\d+$/.test(projectId)) throw new Error('workspace and project ids must be numeric');
  return `workspaces/${workspaceId}/projects/${projectId}/`;
};

export interface StoredObject { bytes: Buffer; contentType: string }

export interface ObjectStore {
  /** Writes an object once. Refuses a key that already exists. Returns the bytes' sha256. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<StoredObject | null>;
  /** Removes every object under a prefix. Only used to clean up a failed run's own work prefix. */
  removePrefix(prefix: string): Promise<void>;
}

export class ObjectExistsError extends Error {}

/** In-process store, for tests and throwaway demos. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    assertStorageKey(key);
    if (this.objects.has(key)) throw new ObjectExistsError('object already exists; stored objects are write-once');
    const b = Buffer.from(bytes);
    this.objects.set(key, { bytes: b, contentType });
    return sha256(b);
  }
  async get(key: string): Promise<StoredObject | null> {
    assertStorageKey(key);
    const o = this.objects.get(key);
    return o ? { bytes: Buffer.from(o.bytes), contentType: o.contentType } : null;
  }
  async removePrefix(prefix: string): Promise<void> {
    assertStorageKey(`${prefix}x`);
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
  }
}

/** Local-disk store rooted at one directory. A stand-in for a bucket; the same key rules apply. */
export class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private file(key: string): string {
    assertStorageKey(key);
    const root = path.resolve(this.root);
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('not a project storage key');
    return p;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const p = this.file(key);
    await mkdir(path.dirname(p), { recursive: true });
    try {
      await writeFile(p, bytes, { flag: 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') throw new ObjectExistsError('object already exists; stored objects are write-once');
      throw err;
    }
    await writeFile(`${p}.type`, contentType, { flag: 'wx' });
    return sha256(bytes);
  }

  async get(key: string): Promise<StoredObject | null> {
    const p = this.file(key);
    try {
      await stat(p);
    } catch {
      return null;
    }
    return { bytes: await readFile(p), contentType: (await readFile(`${p}.type`, 'utf8')).trim() };
  }

  async removePrefix(prefix: string): Promise<void> {
    assertStorageKey(`${prefix}x`);
    const dir = this.file(`${prefix.replace(/\/$/, '')}`);
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A handle on one project's storage. Reads anywhere inside the project; writes only under
 * `writablePrefix` (a run's own work prefix, a person's edit prefix, or assets/). Any key outside
 * is refused before the store is touched.
 */
export class ProjectFiles {
  constructor(private readonly store: ObjectStore, readonly prefix: string, readonly writablePrefix: string) {
    assertStorageKey(`${prefix}x`);
    if (!writablePrefix.startsWith(prefix)) throw new Error('a project handle can only write inside its own project');
  }

  private inside(key: string, within: string): void {
    assertStorageKey(key);
    if (!key.startsWith(within)) throw new Error('key is outside this project handle');
  }

  async read(key: string): Promise<StoredObject | null> {
    this.inside(key, this.prefix);
    return this.store.get(key);
  }

  /** Reads an object and checks it against the hash the database recorded for it. */
  async readVerified(key: string, expectedSha256: string | null): Promise<StoredObject> {
    const o = await this.read(key);
    if (!o) throw new ArtifactIntegrityError('stored object is missing');
    if (!expectedSha256 || sha256(o.bytes) !== expectedSha256) throw new ArtifactIntegrityError('stored object does not match its recorded hash');
    return o;
  }

  async write(name: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string }> {
    const key = `${this.writablePrefix}${name}`;
    this.inside(key, this.writablePrefix);
    return { key, sha256: await this.store.put(key, bytes, contentType) };
  }

  /** A narrower handle that writes only under `sub` of this project. */
  scoped(sub: string): ProjectFiles {
    return new ProjectFiles(this.store, this.prefix, `${this.prefix}${sub}`);
  }
}

export class ArtifactIntegrityError extends Error {}

/** A handle that can read the whole project and write only under a fresh, unique edit prefix. */
export function editFiles(store: ObjectStore, workspaceId: string, projectId: string): ProjectFiles {
  const prefix = projectPrefix(workspaceId, projectId);
  return new ProjectFiles(store, prefix, `${prefix}versions/edit-${randomUUID()}/`);
}
