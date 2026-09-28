// Regenerates fixtures/golden/golden-set.json from the verbatim sources and annotations.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGoldenSet, GOLDEN_DIR } from '../src/golden/build.js';

const set = buildGoldenSet();
writeFileSync(path.join(GOLDEN_DIR, 'golden-set.json'), JSON.stringify(set, null, 2) + '\n');
console.log(JSON.stringify(set.counts, null, 2));
