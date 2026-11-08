// Decrypts a pre-deploy backup offline (src/ops/backup.ts), for a restore or a restore test.
// Never run on the server: it needs the operator's private key, which never goes to Railway.
//
//   SCOPELY_BACKUP_PRIVATE_KEY_FILE=~/scopely-backup-key.pem pnpm backup:decrypt <file.dump.enc> <out.dump>
//   (SCOPELY_BACKUP_PRIVATE_KEY_PASSPHRASE_FILE when the key file is passphrase-protected)
//
// It checks the GCM tag and the dump's recorded sha256, writes the plain dump with mode 0600 and
// prints the header (counts, hashes, pg_dump version). Restore it with pg_restore 18+
// (docs/OPERATIONS.md, "Restore").
import { readFileSync, writeFileSync } from 'node:fs';
import { decryptBackup } from '../src/ops/backup.js';

const [input, output] = process.argv.slice(2);
const keyFile = process.env.SCOPELY_BACKUP_PRIVATE_KEY_FILE;
if (!input || !output || !keyFile) {
  console.error('Usage: SCOPELY_BACKUP_PRIVATE_KEY_FILE=<key.pem> pnpm backup:decrypt <file.dump.enc> <out.dump>');
  process.exit(1);
}
const passFile = process.env.SCOPELY_BACKUP_PRIVATE_KEY_PASSPHRASE_FILE;
const { header, dump } = decryptBackup(readFileSync(input), readFileSync(keyFile, 'utf8'), passFile ? readFileSync(passFile, 'utf8').trim() : undefined);
writeFileSync(output, dump, { mode: 0o600 });
console.log(`Decrypted ${dump.length} bytes; sha256 ${header.dumpSha256} matches. Taken ${header.createdAt}, pg_dump ${header.pgDump}, ${header.entries} archive entries.`);
