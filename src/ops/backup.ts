// The pre-deploy logical backup (docs/OPERATIONS.md, "Operator path"). It replaces running
// scripts/backup-db.sh over `railway ssh` from someone's own machine.
//
// scripts/release.ts runs it in Railway's pre-deploy container, before `migrate`, whenever the
// backup variables are set. That container already holds the service's variables; no request can
// reach it, there is no route, and a workspace member has no way to start it. A failure stops the
// deploy and the running version keeps serving.
//
// Steps, all inside that container:
//   1. pg_dump (custom format) into a private temporary folder. The connection details are
//      passed to pg_dump as PG* variables of the child process only; nothing prints them.
//   2. pg_restore --list must read the archive: a dump that cannot be listed is not a backup.
//   3. Encrypt: a fresh AES-256-GCM key per backup, wrapped with the operator's RSA public key
//      (RSA-OAEP, SHA-256). The server holds only the public key, so neither it nor anyone who
//      reads its variables or the bucket can decrypt a backup. The private key stays offline.
//   4. Upload to object storage under a new, unique key; nothing is overwritten or deleted.
//   5. Read the object back and require the same sha256 and a readable header.
//   6. Delete the temporary folder (the plain dump), whatever happened.
// The result (ids, sizes, hashes, counts) is recorded in operator_events (023).
import { spawn } from 'node:child_process';
import {
  KeyObject, constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes,
} from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '../tenancy/index.js';
import { S3Client, S3Error, type S3Config } from './s3.js';

export const BACKUP_PREFIX = 'scopely-backups/';
// The dump, its ciphertext and the read-back copy are held in memory; the service has 500 MB. Validation data is a few MB.
export const MAX_DUMP_BYTES = 64 * 1024 * 1024;
const MAGIC = Buffer.from('SCOPELY-BACKUP-1\n', 'utf8');

export interface BackupConfig { s3: S3Config; publicKey: KeyObject; keyFingerprint: string }

const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The public key's fingerprint: sha256 of its DER (SPKI) form. Printed so the operator can match it to their private key. */
export const keyFingerprint = (k: KeyObject) => sha256Hex(k.export({ type: 'spki', format: 'der' }));

function loadPublicKey(pem: string): KeyObject {
  // Railway variables often carry a PEM with literal "\n" sequences.
  const text = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  // A private key would derive a public key here, and defeat the point: the server must never hold it.
  if (/PRIVATE KEY/.test(text)) throw new Error('Backup: SCOPELY_BACKUP_PUBLIC_KEY must be the public key. Never put the private key on the server.');
  let key: KeyObject;
  try { key = createPublicKey(text); } catch { throw new Error('Backup: SCOPELY_BACKUP_PUBLIC_KEY is not a PEM public key.'); }
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error('Backup: SCOPELY_BACKUP_PUBLIC_KEY must be an RSA public key of at least 3072 bits.');
  }
  return key;
}

/**
 * Reads the backup variables. None set: null (no backup; the release step says so). Some but not
 * all, or malformed: an error naming the variable, never its value, and the deploy stops.
 */
export function backupConfigFromEnv(env: NodeJS.ProcessEnv): BackupConfig | null {
  const v = (n: string) => env[n]?.trim() ?? '';
  const required = ['SCOPELY_BACKUP_S3_ENDPOINT', 'SCOPELY_BACKUP_S3_BUCKET', 'SCOPELY_BACKUP_S3_ACCESS_KEY_ID', 'SCOPELY_BACKUP_S3_SECRET_ACCESS_KEY', 'SCOPELY_BACKUP_PUBLIC_KEY'];
  const set = required.filter((n) => v(n));
  if (set.length === 0) return null;
  if (set.length < required.length) throw new Error(`Backup: set all of ${required.join(', ')}, or none. Missing: ${required.filter((n) => !v(n)).join(', ')}.`);
  let endpoint: URL;
  try { endpoint = new URL(v('SCOPELY_BACKUP_S3_ENDPOINT')); } catch { throw new Error('Backup: SCOPELY_BACKUP_S3_ENDPOINT is not a URL.'); }
  const local = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost';
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) throw new Error('Backup: SCOPELY_BACKUP_S3_ENDPOINT must be https.');
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password) throw new Error('Backup: SCOPELY_BACKUP_S3_ENDPOINT must be a bare origin, e.g. https://t3.storageapi.dev.');
  const style = v('SCOPELY_BACKUP_S3_URL_STYLE') || 'virtual';
  if (style !== 'virtual' && style !== 'path') throw new Error('Backup: SCOPELY_BACKUP_S3_URL_STYLE is virtual or path.');
  const bucket = v('SCOPELY_BACKUP_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Backup: SCOPELY_BACKUP_S3_BUCKET is not a bucket name.');
  const publicKey = loadPublicKey(v('SCOPELY_BACKUP_PUBLIC_KEY'));
  return {
    s3: { endpoint: endpoint.origin, bucket, region: v('SCOPELY_BACKUP_S3_REGION') || 'auto', urlStyle: style,
      accessKeyId: v('SCOPELY_BACKUP_S3_ACCESS_KEY_ID'), secretAccessKey: v('SCOPELY_BACKUP_S3_SECRET_ACCESS_KEY') },
    publicKey, keyFingerprint: keyFingerprint(publicKey),
  };
}

// ------------------------------------------------------------------------------- the envelope

export interface BackupHeader {
  v: 1; cipher: 'aes-256-gcm'; keyWrap: 'rsa-oaep-sha256'; keyFingerprint: string;
  wrappedKey: string; iv: string; dumpSha256: string; dumpBytes: number; entries: number; pgDump: string; createdAt: string;
}

/** Encrypts a dump to the public key. Layout: MAGIC, uint32 header length, header JSON, ciphertext, 16-byte GCM tag; MAGIC..header is the AAD. */
export function encryptBackup(dump: Buffer, publicKey: KeyObject, meta: { entries: number; pgDump: string; createdAt: string }): Buffer {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const header: BackupHeader = {
    v: 1, cipher: 'aes-256-gcm', keyWrap: 'rsa-oaep-sha256', keyFingerprint: keyFingerprint(publicKey),
    wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey).toString('base64'),
    iv: iv.toString('base64'), dumpSha256: sha256Hex(dump), dumpBytes: dump.length, ...meta,
  };
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  const aad = Buffer.concat([MAGIC, len, h]);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(dump), cipher.final()]);
  dataKey.fill(0);
  return Buffer.concat([aad, body, cipher.getAuthTag()]);
}

/** Reads the header without any key (for the read-back check). Throws on anything that is not a Scopely backup. */
export function readBackupHeader(buf: Buffer): { header: BackupHeader; aadLength: number } {
  if (buf.length < MAGIC.length + 4 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Scopely backup');
  const n = buf.readUInt32BE(MAGIC.length);
  if (n > 64 * 1024 || MAGIC.length + 4 + n + 16 > buf.length) throw new Error('not a Scopely backup');
  const header = JSON.parse(buf.subarray(MAGIC.length + 4, MAGIC.length + 4 + n).toString('utf8')) as BackupHeader;
  if (header.v !== 1 || header.cipher !== 'aes-256-gcm' || header.keyWrap !== 'rsa-oaep-sha256' || !/^[0-9a-f]{64}$/.test(header.dumpSha256)) throw new Error('not a Scopely backup');
  return { header, aadLength: MAGIC.length + 4 + n };
}

/** Decrypts with the operator's private key and checks the dump's sha256. Used offline (scripts/backup-decrypt.ts), never by the server. */
export function decryptBackup(buf: Buffer, privateKeyPem: string, passphrase?: string): { header: BackupHeader; dump: Buffer } {
  const { header, aadLength } = readBackupHeader(buf);
  const key = createPrivateKey(passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem);
  const dataKey = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(buf.subarray(0, aadLength));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const dump = Buffer.concat([decipher.update(buf.subarray(aadLength, buf.length - 16)), decipher.final()]);
  if (sha256Hex(dump) !== header.dumpSha256) throw new Error('decrypted dump does not match its recorded sha256');
  return { header, dump };
}

// ----------------------------------------------------------------------------------- the run

export type BackupFailure = 'pg_dump_failed' | 'dump_too_large' | 'archive_unreadable' | 'upload_failed' | 'readback_mismatch' | 'readback_failed' | 'timeout';

export class BackupFailed extends Error {
  constructor(readonly reason: BackupFailure, detail = '') { super(`backup failed: ${reason}${detail ? ` (${detail})` : ''}`); }
}

export interface BackupResult {
  objectKey: string; sizeBytes: number; ciphertextSha256: string; dumpSha256: string; entries: number; pgDumpVersion: string;
}

/** PG* variables for the child process, from a postgres:// URL. The URL itself is never passed or printed. */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  const u = new URL(databaseUrl);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('DATABASE_URL is not a postgres URL');
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(u.hostname), PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

interface RunOut { code: number | null; stdout: Buffer; timedOut: boolean }
function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<RunOut> {
  return new Promise((resolve) => {
    // Only PATH and the PG* values reach the child: none of the service's other variables.
    const child = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.resume(); // pg_dump's messages can name the host or role; they are discarded, never printed.
    child.on('error', () => { clearTimeout(t); resolve({ code: -1, stdout: Buffer.alloc(0), timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: Buffer.concat(out), timedOut }); });
  });
}

export interface ObjectStore { put(key: string, body: Buffer, contentType?: string): Promise<void>; get(key: string): Promise<Buffer> }

export interface BackupDeps {
  databaseUrl: string;
  cfg: BackupConfig;
  store?: ObjectStore;
  now?: () => Date;
  pgDump?: string;
  pgRestore?: string;
  timeoutMs?: number;
}

export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const now = deps.now ?? (() => new Date());
  const pgDump = deps.pgDump ?? 'pg_dump';
  const pgRestore = deps.pgRestore ?? 'pg_restore';
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  const store = deps.store ?? new S3Client(deps.cfg.s3);
  const env = pgEnvFromUrl(deps.databaseUrl);
  const dir = await mkdtemp(path.join(tmpdir(), 'scopely-backup-')); // mode 0700
  const file = path.join(dir, 'scopely.dump');
  try {
    const version = await run(pgDump, ['--version'], {}, 30_000);
    const pgDumpVersion = /(\d+(?:\.\d+)+)/.exec(version.stdout.toString('utf8'))?.[1] ?? '';
    if (version.code !== 0 || !pgDumpVersion) throw new BackupFailed('pg_dump_failed', 'pg_dump is not installed');

    const dump = await run(pgDump, ['--format=custom', '--compress=6', '--no-password', `--file=${file}`], env, timeoutMs);
    if (dump.timedOut) throw new BackupFailed('timeout', 'pg_dump');
    if (dump.code !== 0) throw new BackupFailed('pg_dump_failed', `exit ${dump.code}`);
    const size = (await stat(file)).size;
    if (size > MAX_DUMP_BYTES) throw new BackupFailed('dump_too_large', `${size} bytes`);

    const list = await run(pgRestore, ['--list', file], {}, timeoutMs);
    const entries = list.stdout.toString('utf8').split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
    if (list.code !== 0 || entries === 0) throw new BackupFailed('archive_unreadable');

    const plain = await readFile(file);
    const createdAt = now().toISOString();
    const sealed = encryptBackup(plain, deps.cfg.publicKey, { entries, pgDump: pgDumpVersion, createdAt });
    const dumpSha256 = sha256Hex(plain);
    plain.fill(0);
    const ciphertextSha256 = sha256Hex(sealed);
    const objectKey = `${BACKUP_PREFIX}${createdAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(4).toString('hex')}.dump.enc`;

    try { await store.put(objectKey, sealed); } catch (err) { throw new BackupFailed('upload_failed', err instanceof S3Error ? err.message : 'network'); }
    let back: Buffer;
    try { back = await store.get(objectKey); } catch (err) { throw new BackupFailed('readback_failed', err instanceof S3Error ? err.message : 'network'); }
    if (sha256Hex(back) !== ciphertextSha256) throw new BackupFailed('readback_mismatch');
    try {
      if (readBackupHeader(back).header.dumpSha256 !== dumpSha256) throw new Error('header');
    } catch { throw new BackupFailed('readback_mismatch'); }

    return { objectKey, sizeBytes: sealed.length, ciphertextSha256, dumpSha256, entries, pgDumpVersion };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Records a backup's outcome in operator_events (023), when that table exists yet. */
export async function recordBackup(db: Db, outcome: BackupResult | BackupFailed, now = new Date()): Promise<boolean> {
  if (!(await db.query(`SELECT to_regclass('scopely.operator_events') AS t`)).rows[0]?.t) return false;
  if (outcome instanceof BackupFailed) {
    await db.query(`INSERT INTO scopely.operator_events (kind, reason, created_at) VALUES ('backup_failed', $1, $2)`, [outcome.reason, now]);
  } else {
    await db.query(`INSERT INTO scopely.operator_events (kind, object_key, size_bytes, ciphertext_sha256, dump_sha256, archive_entries, pg_dump_version, created_at)
      VALUES ('backup_completed', $1, $2, $3, $4, $5, $6, $7)`,
    [outcome.objectKey, outcome.sizeBytes, outcome.ciphertextSha256, outcome.dumpSha256, outcome.entries, outcome.pgDumpVersion, now]);
  }
  return true;
}
