// Project images: only raster images the seller or client supplied, identified by their bytes
// (never by a file name or a declared type), and read back only when they match their recorded
// hash. SVG is refused: it can carry script.
import type { ProjectFiles } from '../../storage/index.js';
import type { SiteDocument } from './document.js';
import type { RenderImage } from './render.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The image type from its magic bytes, or null when it is not an accepted raster image. */
export function imageType(b: Buffer): RenderImage['contentType'] | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

export const EXT: Record<RenderImage['contentType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface ImageAsset { assetId: string; storageRef: string; sha256: string | null; description: string }

/** Asset ids a document places on the page. */
export function placedImages(doc: SiteDocument): string[] {
  const ids = new Set<string>();
  for (const s of doc.sections) {
    if ((s.type === 'hero' || s.type === 'about') && typeof s.content.image === 'string') ids.add(s.content.image);
    if (s.type === 'gallery' && Array.isArray(s.content.images)) for (const x of s.content.images) if (typeof x === 'string') ids.add(x);
  }
  return [...ids];
}

/** Reads and verifies the images a document places. A missing or altered image fails the render. */
export async function loadPlacedImages(files: ProjectFiles, assets: ImageAsset[], doc: SiteDocument): Promise<Map<string, RenderImage>> {
  const out = new Map<string, RenderImage>();
  for (const id of placedImages(doc)) {
    const a = assets.find((x) => x.assetId === id);
    if (!a) throw new Error('an image placed on the site is no longer part of this project');
    const o = await files.readVerified(a.storageRef, a.sha256);
    const type = imageType(o.bytes);
    if (!type) throw new Error('a placed image is not an accepted image type');
    out.set(id, { contentType: type, bytes: o.bytes, alt: a.description });
  }
  return out;
}
