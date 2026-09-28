// Preview access. Stored artifacts are never addressed by their storage key from a browser. A
// preview link is a signed, expiring token naming one workspace, project and version; serving it
// re-checks all three against the database inside that workspace, and serves the bytes only if
// they match the hash recorded on the version. A `show` link only opens a version that a person
// approved and marked shown, through a link row (preview_links) that has not expired or been
// revoked; revoking the row stops the link on its next request.
//
// The signing key is a platform secret held by the server process (PREVIEW_SIGNING_KEY). It is not
// a model credential, never stored in a row and never sent to a browser.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type ObjectStore, ProjectFiles, projectPrefix } from '../../storage/index.js';
import { type Db, withWorkspace } from '../../tenancy/index.js';

export interface PreviewClaims {
  /** workspace, project, build (version) */
  w: string; p: string; b: string;
  /** edit: the Build Workspace's own view of any version. show: what a prospect may open. */
  k: 'edit' | 'show';
  /** expiry, unix seconds */
  e: number;
  /** show links only: the preview_links row that can be revoked */
  l?: string;
}

/** How long a prospect's link lasts unless the seller revokes it first (A15). */
export const DEFAULT_SHOW_LINK_TTL_SECONDS = 72 * 3600;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signPreview(key: string, c: PreviewClaims): string {
  if (key.length < 32) throw new Error('the preview signing key must be at least 32 characters');
  const body = b64url(JSON.stringify(c));
  return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`;
}

/** The claims of a valid, unexpired token, or null. */
export function verifyPreview(key: string, token: string, nowSeconds: number): PreviewClaims | null {
  const m = /^([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const expected = createHmac('sha256', key).update(m[1]!).digest();
  const given = Buffer.from(m[2]!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: PreviewClaims;
  try { c = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')); } catch { return null; }
  if (![c.w, c.p, c.b].every((x) => typeof x === 'string' && /^\d+$/.test(x)) || (c.k !== 'edit' && c.k !== 'show') || typeof c.e !== 'number') return null;
  if (c.k === 'show' ? typeof c.l !== 'string' || !/^\d+$/.test(c.l) : c.l !== undefined) return null;
  if (c.e < nowSeconds) return null;
  return c;
}

export interface ServedArtifact { html: Buffer; brandTitle: string; status: string }

/**
 * Loads the artifact a token grants, inside the token's workspace. The caller owns the
 * transaction. Returns null for anything that does not check out, without saying which check failed.
 */
export async function loadPreviewArtifact(db: Db, store: ObjectStore, c: PreviewClaims): Promise<ServedArtifact | null> {
  return withWorkspace(db, c.w, async () => {
    const b = (await db.query(
      `SELECT b.artifact_ref, b.artifact_sha256, b.status, b.shown_at, b.title FROM scopely.builds b
        WHERE b.id = $1 AND b.project_id = $2 AND b.workspace_id = scopely.current_workspace_id()`, [c.b, c.p])).rows[0];
    if (!b || !b.artifact_ref || !b.artifact_sha256) return null;
    if (c.k === 'show') {
      if (b.shown_at === null) return null;
      const link = (await db.query(
        `SELECT 1 FROM scopely.preview_links WHERE id = $1 AND build_id = $2 AND project_id = $3
            AND workspace_id = scopely.current_workspace_id() AND revoked_at IS NULL AND expires_at > now()`, [c.l, c.b, c.p])).rows[0];
      if (!link) return null;
    }
    const prefix = projectPrefix(c.w, c.p);
    if (!String(b.artifact_ref).startsWith(`${prefix}versions/`)) return null;
    try {
      const o = await new ProjectFiles(store, prefix, `${prefix}versions/`).readVerified(b.artifact_ref, b.artifact_sha256);
      return { html: o.bytes, brandTitle: b.title, status: b.status };
    } catch {
      return null;
    }
  });
}

/** Headers for serving an artifact: no script, no network, an opaque origin, no framing by strangers. */
export const ARTIFACT_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
};
