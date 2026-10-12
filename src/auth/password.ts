// Password hashing with Node's built-in scrypt (RFC 7914), a standard memory-hard KDF. Nothing
// here is a new protocol: a random salt per password, a fixed-length derived key, and a
// constant-time comparison. The encoded form records its parameters so they can be raised later
// without invalidating stored hashes:
//
//   scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 128 * N * R * 2;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, len, { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) }, (err, key) => err ? reject(err) : resolve(key)));
}

/** Why a password cannot be used, or null. Length only: a long passphrase is the advice. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, N, R, P, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 2 ** 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (expected.length < 32) return false;
  const key = await scrypt(password, salt, n, r, p, expected.length);
  return timingSafeEqual(key, expected);
}

// A fixed hash to compare against when the email is unknown, so a missing account and a wrong
// password take the same time.
let dummy: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(18).toString('base64url'));
  await verifyPassword(password, await dummy);
}
