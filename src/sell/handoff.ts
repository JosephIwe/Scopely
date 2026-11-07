// The approved-draft handoff (P5): once a named person has approved a draft, Scopely hands the
// final text to that person to send from their own inbox, then records that they sent it.
//
// Scopely never sends. There is no mail server, no provider API and no OAuth here: the handoff is the
// approved subject and body to copy, and a mailto: link the person's own email app opens. A mailto
// link carries only the approved recipient (captured from the contact at approval), the approved
// subject and the approved body, every part percent-encoded, so nothing a contact record or a
// draft holds can add a Cc, a Bcc or another header.
//
// Pure: no database, no network.

/** Most email apps cope with mailto links up to about 2,000 characters; beyond that, copy instead. */
export const MAX_MAILTO = 2000;

/** One plain address: no display name, no list, nothing a mailto query could read as a header. */
const SAFE_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

export interface HandoffInput {
  approvalStatus: string;
  sentAt: string | null;
  lintStatus: string;
  /** The address captured at approval (messages.recipient_email). */
  recipientEmail: string | null;
  senderEmail: string | null;
  subject: string;
  body: string;
}

export interface Handoff {
  to: string;
  from: string | null;
  subject: string;
  body: string;
  /** The text to paste: the subject line, a blank line, the body. */
  copyText: string;
  /** A mailto: link for the person's own email app, or null with the reason. */
  mailto: string | null;
  mailtoUnavailable: string | null;
}

/** RFC 6068: percent-encode everything but unreserved characters; line breaks become CRLF. */
const enc = (s: string) => encodeURIComponent(s.replace(/\r\n?|\n/g, '\r\n'));

export function isSafeAddress(addr: string | null | undefined): addr is string {
  return typeof addr === 'string' && SAFE_ADDRESS.test(addr);
}

export function mailtoHref(to: string, subject: string, body: string): string {
  if (!isSafeAddress(to)) throw new Error('mailto: not a plain address');
  // The address is already plain (SAFE_ADDRESS); only a literal % needs escaping. The @ stays as is,
  // because some email apps do not decode %40 in the address.
  return `mailto:${to.replace(/%/g, '%25')}?subject=${enc(subject)}&body=${enc(body)}`;
}

/**
 * The handoff for an approved, unsent draft whose lint passed and whose recipient was captured at
 * approval; null for anything else, so a pending, rejected or failed draft is never offered to send.
 */
export function handoffOf(m: HandoffInput): Handoff | null {
  if (!['approved', 'edited'].includes(m.approvalStatus) || m.sentAt !== null || m.lintStatus !== 'pass') return null;
  if (!m.recipientEmail) return null;
  const copyText = `Subject: ${m.subject}\n\n${m.body}`;
  let mailto: string | null = null;
  let mailtoUnavailable: string | null = null;
  if (!isSafeAddress(m.recipientEmail)) {
    mailtoUnavailable = 'The address is not a plain email address, so Scopely will not build a link for it. Copy the message instead.';
  } else {
    const href = mailtoHref(m.recipientEmail, m.subject, m.body);
    if (href.length > MAX_MAILTO) mailtoUnavailable = 'The message is too long for an email link. Copy it instead.';
    else mailto = href;
  }
  return { to: m.recipientEmail, from: m.senderEmail, subject: m.subject, body: m.body, copyText, mailto, mailtoUnavailable };
}
