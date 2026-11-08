// Outreach wording that is still an open decision (B4: the Article 14 notice wording versus
// "no links on Day 0", D5). It lives here, and only here, so that settling B4 changes one file
// plus a new lint rule version, and no other code.
//
// Until B4 is decided, a first message carries only a plain reply-to-opt-out sentence and no links
// of Scopely's own. The lint (lint.outreach_draft v1) requires a sentence that OPT_OUT_PATTERN
// recognises; a test keeps the sentence and the pattern in step.
//
// This is code, not an environment variable, on purpose: the wording is a compliance decision, so
// it changes through a reviewed commit (and a new rule_versions row), never through a deploy setting.

export const OUTREACH_WORDING = {
  /** Which decision this wording waits on, shown beside the drafts. */
  decision: 'B4',
  /** Whether B4 is settled. While false the conservative wording below is used. */
  settled: false,
  /** The opt-out sentence every Scopely draft ends with. */
  optOutSentence: 'If you would rather not hear from me, reply "no thanks" and I won\'t contact you again.',
  /** What the lint accepts as an opt-out sentence in a person's edit. */
  optOutPattern: /won['’]t contact you again|will not contact you again|\bunsubscribe\b/i,
  /** The closing line before the opt-out sentence. No link, no tracking. */
  closingLine: 'If you would like the details, reply to this email.',
} as const;
