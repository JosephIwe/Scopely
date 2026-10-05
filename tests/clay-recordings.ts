// The Clay responses recorded on 2026-10-05 (fixtures/providers/clay), replayed in tests: the two
// searches recorded for Slice 10, and the same search with the country pushed down, recorded for
// its review.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RecordedClayTransport, type ClayRecording } from '../src/providers/index.js';

const DIR = path.resolve(import.meta.dirname, '../fixtures/providers/clay');
export const CLAY_RECORDINGS = ['2026-10-05-company-search.json', '2026-10-05-company-search-country.json'];

export function recordedClay(): RecordedClayTransport {
  return new RecordedClayTransport(CLAY_RECORDINGS.flatMap((f) =>
    (JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as { searches: ClayRecording[] }).searches));
}
