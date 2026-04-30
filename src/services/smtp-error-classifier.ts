/**
 * SMTP error classification + provider guidance
 *
 * Distinguishes transient (retry-worthy) errors from permanent (don't
 * retry) and authentication (surface immediately with provider hint)
 * failures. Inspects both nodemailer error codes and SMTP response codes.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 0.1.0
 *
 * Tracker: #97. Issue: #99 (WP3).
 */

export type ErrorCategory =
  | 'transient'        // 4xx, network glitch, TLS handshake, EAI_AGAIN — retry with backoff
  | 'permanent'        // 5xx (non-auth), malformed message, oversize — surface, do not retry
  | 'authentication'   // 530, 535, 538 — surface with provider guidance, do not retry
  | 'configuration';   // bad host, port, missing creds — surface, do not retry

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  smtpCode: number | null;
  smtpMessage: string;
  providerGuidance: string | null;
  rawMessage: string;
}

/**
 * Per-host guidance for the most common authentication failures.
 * Conservative — only entries we're highly confident in.
 */
const PROVIDER_GUIDANCE: Array<{ match: RegExp; hint: string }> = [
  {
    match: /(^|\.)(gmail\.com|googlemail\.com)$/i,
    hint: 'Gmail requires an app password (the regular account password is rejected). ' +
          'Generate one at https://myaccount.google.com/apppasswords and use it as the SMTP password.',
  },
  {
    match: /(^|\.)(office365\.com|outlook\.com|hotmail\.com|live\.com)$/i,
    hint: 'Microsoft 365 / Outlook may require modern auth (OAuth 2.0) or an app password. ' +
          'Personal accounts: enable two-step verification, then create an app password at ' +
          'https://account.live.com/proofs/AppPassword. Business accounts: ask your admin to enable SMTP AUTH.',
  },
  {
    match: /(^|\.)(yahoo\.com|aol\.com)$/i,
    hint: 'Yahoo / AOL require an app password. Generate one in Account Security → App passwords.',
  },
  {
    match: /(^|\.)(icloud\.com|me\.com|mac\.com)$/i,
    hint: 'iCloud Mail requires an app-specific password. Generate one at https://appleid.apple.com → Sign-In and Security.',
  },
  {
    match: /(^|\.)fastmail\.com$/i,
    hint: 'Fastmail requires an app-specific password (account password is rejected for SMTP). ' +
          'Create one at https://www.fastmail.com/settings/security/devicekeys.',
  },
  {
    match: /(^|\.)protonmail\./i,
    hint: 'ProtonMail requires the ProtonMail Bridge to be running locally (free for paid plans). ' +
          'See https://proton.me/mail/bridge.',
  },
];

/** Try to extract a 3-digit SMTP response code from various error shapes. */
function extractSmtpCode(err: any): { code: number | null; message: string } {
  // nodemailer attaches `responseCode` for SMTP errors
  if (typeof err?.responseCode === 'number') {
    return { code: err.responseCode, message: String(err.response ?? err.message ?? '') };
  }
  // Fall back to scanning the message for "5XX " or "4XX "
  const text = String(err?.message ?? err ?? '');
  const m = text.match(/\b([45]\d\d)\b/);
  if (m) return { code: Number(m[1]), message: text };
  return { code: null, message: text };
}

/** Provider guidance for an SMTP host (or null if no rule matches). */
export function providerGuidanceFor(smtpHost: string): string | null {
  if (!smtpHost) return null;
  const hit = PROVIDER_GUIDANCE.find((p) => p.match.test(smtpHost));
  return hit?.hint ?? null;
}

/**
 * Classify a thrown error from a nodemailer send.
 */
export function classifySmtpError(err: any, smtpHost: string): ClassifiedError {
  const { code, message } = extractSmtpCode(err);
  const rawMessage = String(err?.message ?? err ?? '');
  const errCode = String(err?.code ?? '');

  // ---- Authentication failures: don't retry, surface guidance ----
  if (code === 530 || code === 535 || code === 538 || errCode === 'EAUTH') {
    return {
      category: 'authentication',
      retryable: false,
      smtpCode: code,
      smtpMessage: message,
      providerGuidance: providerGuidanceFor(smtpHost),
      rawMessage,
    };
  }

  // ---- Configuration errors: don't retry ----
  if (errCode === 'EDNS' || errCode === 'EHOSTUNREACH' || /Invalid login|getaddrinfo ENOTFOUND/i.test(rawMessage)) {
    return {
      category: 'configuration',
      retryable: false,
      smtpCode: code,
      smtpMessage: message || rawMessage,
      providerGuidance: null,
      rawMessage,
    };
  }

  // ---- Transient: 4xx + classic network errors ----
  if (
    (code !== null && code >= 400 && code < 500) ||
    errCode === 'ETIMEDOUT' || errCode === 'ECONNECTION' || errCode === 'ECONNRESET' ||
    errCode === 'ESOCKET' || errCode === 'EAI_AGAIN' || errCode === 'ETLS' ||
    /TLS handshake|Connection (closed|timeout)|socket hang up/i.test(rawMessage)
  ) {
    return {
      category: 'transient',
      retryable: true,
      smtpCode: code,
      smtpMessage: message || rawMessage,
      providerGuidance: null,
      rawMessage,
    };
  }

  // ---- Permanent (5xx other than auth, malformed/oversized message) ----
  if (code !== null && code >= 500) {
    return {
      category: 'permanent',
      retryable: false,
      smtpCode: code,
      smtpMessage: message,
      providerGuidance: null,
      rawMessage,
    };
  }

  // ---- Default: treat unknowns as transient (safer for one retry) ----
  return {
    category: 'transient',
    retryable: true,
    smtpCode: code,
    smtpMessage: message || rawMessage,
    providerGuidance: null,
    rawMessage,
  };
}

/** Backoff math: min(base * 2^(attempt-1) + jitter, max). attempt is 1-based. */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterMaxMs: number = 500
): number {
  const expo = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * jitterMaxMs);
  return Math.min(expo + jitter, maxMs);
}
