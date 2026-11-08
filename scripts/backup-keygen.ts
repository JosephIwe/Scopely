// Makes the backup key pair (src/ops/backup.ts): RSA-4096. Run it where the private key will be
// kept, never on the server.
//
//   pnpm backup:keygen <private-key-out.pem>
//   (SCOPELY_BACKUP_PRIVATE_KEY_PASSPHRASE_FILE to protect the private key with a passphrase)
//
// Writes the private key with mode 0600 and prints the public key, which is what goes into the
// service variable SCOPELY_BACKUP_PUBLIC_KEY, and its fingerprint.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { keyFingerprint } from '../src/ops/backup.js';

const out = process.argv[2];
if (!out) { console.error('Usage: pnpm backup:keygen <private-key-out.pem>'); process.exit(1); }
if (existsSync(out)) { console.error(`${out} exists; refusing to overwrite a key.`); process.exit(1); }
const passFile = process.env.SCOPELY_BACKUP_PRIVATE_KEY_PASSPHRASE_FILE;
const passphrase = passFile ? readFileSync(passFile, 'utf8').trim() : undefined;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: passphrase ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase } : { type: 'pkcs8', format: 'pem' },
});
writeFileSync(out, privateKey, { mode: 0o600 });
console.log(publicKey.trim());
console.log(`fingerprint ${keyFingerprint(createPublicKey(publicKey))}`);
