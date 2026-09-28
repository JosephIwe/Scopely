// The typefaces the template's type pairings use, shipped with Scopely (all SIL Open Font
// Licence 1.1; the licences sit beside the files in src/assets/fonts). A rendered site embeds the
// faces its pairing needs as data: URLs, so it stays one self-contained file with no external
// request, and the same document still gives the same bytes. The workspace UI serves the same
// files from its own origin.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');

export interface FontFace { family: string; file: string; weight: string }

export const FACES: Record<string, FontFace> = {
  geist: { family: 'Geist', file: 'geist-latin-wght.woff2', weight: '100 900' },
  instrument: { family: 'Instrument Serif', file: 'instrument-serif-latin-400.woff2', weight: '400' },
  newsreader400: { family: 'Newsreader', file: 'newsreader-latin-400.woff2', weight: '400' },
  newsreader500: { family: 'Newsreader', file: 'newsreader-latin-500.woff2', weight: '500' },
};

const cache = new Map<string, string>();

/** `@font-face` rules for the given faces, each embedding its file. */
export function embeddedFontFaces(keys: readonly string[]): string {
  return keys.map((k) => {
    const f = FACES[k];
    if (!f) throw new Error(`unknown font face ${k}`);
    let b64 = cache.get(f.file);
    if (!b64) {
      b64 = readFileSync(path.join(FONT_DIR, f.file)).toString('base64');
      cache.set(f.file, b64);
    }
    return `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
  }).join('');
}
