// Public sign-up proves the email address first (A53, migration 024).
//
// With open sign-up on, a person asks for a code; Scopely emails a 6-digit code to that address
// and creates the account and its workspace only when the code comes back with the sign-up. The
// code is stored as sha256 only, works once, for 15 minutes, for at most 5 wrong guesses.
//
// The email goes only to the person who typed their own address into the sign-up form. It is never
// sent to a business or a prospect, carries no tracking, and its text and the code are never logged.
// Requesting a code answers the same whether or not an account exists, so the form cannot be used
// to find out who has one: an address that already has an account is sent a note to sign in instead
// (same caps, same timing), and the code recorded for it is never sent, so it can never be used.
import { createHash, randomInt } from 'node:crypto';
import type { Db } from '../tenancy/index.js';
import { AuthRejected, normalEmail } from './session.js';

export const SIGNUP_CODE_TTL_SECONDS = 15 * 60;
/** Codes one address may be sent per hour, and codes the whole server sends per day: caps on cost and abuse. */
export const CODES_PER_EMAIL_PER_HOUR = 3;
export const CODES_PER_DAY = 300;
const MAX_ATTEMPTS = 5;

const codeHash = (email: string, code: string) => createHash('sha256').update(`${email}\n${code}`, 'utf8').digest('hex');

export interface MailMessage { to: string; subject: string; text: string }
/** Sends one plain-text email. Implementations never log the address or the text. */
export interface Mailer { readonly name: string; send(msg: MailMessage): Promise<void> }

export class MailUnavailable extends Error {}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number }>;

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). One request per message. */
export function resendMailer(apiKey: string, from: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Mailer {
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(apiKey)) throw new Error('SCOPELY_MAIL_API_KEY is not a Resend API key (it starts with re_).');
  if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$|^[^<>]+<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(from)) throw new Error('SCOPELY_MAIL_FROM must be an address, or Name <address>.');
  return {
    name: 'resend',
    async send(msg) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      try {
        const r = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', signal: ctl.signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
        });
        if (!r.ok) throw new MailUnavailable(`mail service answered ${r.status}`);
      } catch (err) {
        if (err instanceof MailUnavailable) throw err;
        throw new MailUnavailable('mail service unreachable');
      } finally { clearTimeout(timer); }
    },
  };
}

/** Builds the mailer from the environment, or null when sign-up email is not configured. */
export function mailerFromEnv(env: Record<string, string | undefined>): Mailer | null {
  const key = env.SCOPELY_MAIL_API_KEY?.trim();
  const from = env.SCOPELY_MAIL_FROM?.trim();
  if (!key && !from) return null;
  if (!key || !from) throw new Error('Set both SCOPELY_MAIL_API_KEY and SCOPELY_MAIL_FROM, or neither.');
  return resendMailer(key, from);
}

/** For an address that already has an account: no code, only the way back in. */
export function existingAccountEmail(to: string): MailMessage {
  return {
    to,
    subject: 'You already have a Scopely account',
    text: 'Someone asked to create a Scopely workspace with this email address, but it already has an account.\n\n'
      + 'Sign in with your password instead. If this was not you, ignore this email: nothing has changed.\n',
  };
}

export function signupCodeEmail(to: string, code: string): MailMessage {
  return {
    to,
    subject: `${code} is your Scopely sign-up code`,
    text: `Your Scopely sign-up code is ${code}\n\nEnter it on the sign-up page within 15 minutes. It works once.\n\n`
      + 'If you did not ask to create a Scopely workspace, ignore this email: nothing is created without the code.\n',
  };
}

/**
 * Records a new code for this address and returns it for the mailer, or null when the address already
 * has an account (the caller sends existingAccountEmail). Every request is recorded, so the caps
 * count both kinds alike. Refuses when the address or the server is over its cap.
 */
export async function startSignupVerification(db: Db, emailIn: unknown, now = new Date()): Promise<{ email: string; code: string | null }> {
  const email = normalEmail(emailIn);
  if (!email) throw new AuthRejected(400, 'Enter a valid email address.');
  const recent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM scopely.signup_verifications
    WHERE email = $1 AND created_at > $2::timestamptz - interval '1 hour'`, [email, now])).rows[0]!.n;
  if (recent >= CODES_PER_EMAIL_PER_HOUR) throw new AuthRejected(429, 'Too many codes for this address. Wait an hour, or use the last code you were sent.', 'rate_limited');
  const today = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM scopely.signup_verifications
    WHERE created_at > $1::timestamptz - interval '1 day'`, [now])).rows[0]!.n;
  if (today >= CODES_PER_DAY) throw new AuthRejected(429, 'Sign-up is busy right now. Try again later.', 'rate_limited');
  const exists = (await db.query(`SELECT 1 FROM scopely.users u JOIN scopely.user_credentials c ON c.user_id = u.id WHERE lower(u.email) = $1`, [email])).rowCount;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(`INSERT INTO scopely.signup_verifications (email, code_sha256, created_at, expires_at)
    VALUES ($1, $2, $3, $3::timestamptz + make_interval(secs => $4))`, [email, codeHash(email, code), now, SIGNUP_CODE_TTL_SECONDS]);
  return { email, code: exists ? null : code };
}

const CODE_RE = /^\d{6}$/;

/**
 * Checks a code without using it. A wrong code counts against the newest open code for the address;
 * the caller commits this before refusing, so guesses are counted. Returns null when it matches.
 */
export async function checkSignupCode(db: Db, emailIn: unknown, codeIn: unknown, now = new Date()): Promise<AuthRejected | null> {
  const email = normalEmail(emailIn);
  const code = typeof codeIn === 'string' ? codeIn.trim() : '';
  if (!email) return new AuthRejected(400, 'Enter a valid email address.');
  if (!CODE_RE.test(code)) return new AuthRejected(400, 'Enter the 6-digit code from the email.', 'code_invalid');
  const v = (await db.query(`SELECT id, code_sha256, attempts FROM scopely.signup_verifications
    WHERE email = $1 AND used_at IS NULL AND expires_at > $2 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [email, now])).rows[0];
  if (!v || v.attempts >= MAX_ATTEMPTS) return new AuthRejected(400, 'That code has expired or was used up. Ask for a new one.', 'code_expired');
  if (v.code_sha256 === codeHash(email, code)) return null;
  await db.query('UPDATE scopely.signup_verifications SET attempts = attempts + 1 WHERE id = $1', [v.id]);
  const left = MAX_ATTEMPTS - v.attempts - 1;
  return new AuthRejected(400, left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is not right, and it is now used up. Ask for a new one.', 'code_invalid');
}

/** Uses the code, in the same transaction that creates the account. Refuses anything checkSignupCode would. */
export async function consumeSignupCode(db: Db, emailIn: unknown, codeIn: unknown, now = new Date()): Promise<void> {
  const email = normalEmail(emailIn);
  const code = typeof codeIn === 'string' ? codeIn.trim() : '';
  const u = email && CODE_RE.test(code) ? await db.query(`UPDATE scopely.signup_verifications SET used_at = $3
    WHERE id = (SELECT id FROM scopely.signup_verifications WHERE email = $1 AND used_at IS NULL AND expires_at > $3
                 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE) AND code_sha256 = $2 AND attempts < ${MAX_ATTEMPTS}`,
    [email, codeHash(email, code), now]) : null;
  if (!u?.rowCount) throw new AuthRejected(400, 'That code has expired or was used up. Ask for a new one.', 'code_expired');
}
