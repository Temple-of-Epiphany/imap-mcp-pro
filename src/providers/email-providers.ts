// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Email provider connection presets.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)
//
// A catalog of well-known mail providers and the standard IMAP/SMTP endpoints
// they publish. Connection values (hostnames, ports, transport security) are
// public, factual settings documented by each provider. To keep the catalog
// compact and uniform it is authored through the `preset()` factory below
// rather than as hand-written object literals. Two helpers resolve an entry
// either by its stable `id` or by matching the domain of an email address.

/**
 * Transport security mode for an IMAP/SMTP endpoint.
 * - `SSL`/`TLS`  — implicit TLS from the first byte (e.g. IMAP 993, SMTP 465).
 * - `STARTTLS`   — plaintext connect that upgrades to TLS (e.g. SMTP 587).
 */
export type TransportSecurity = 'TLS' | 'SSL' | 'STARTTLS';

export interface EmailProvider {
  /** Stable identifier used by tools/APIs to look this preset up. */
  readonly id: string;
  /** Short provider name. */
  readonly name: string;
  /** Human-friendly product name shown in UIs. */
  readonly displayName: string;
  /** Icon URL or app-relative path for the provider logo (web UI). */
  readonly iconUrl: string;
  /** Brand accent color (hex). */
  readonly color: string;
  /** Incoming mail server. */
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecurity: TransportSecurity;
  /** Outgoing mail server — omitted for receive-only presets. */
  readonly smtpHost?: string;
  readonly smtpPort?: number;
  readonly smtpSecurity?: TransportSecurity;
  /** Address domains that map to this provider (used for auto-detection). */
  readonly domains: string[];
  /** Link to the provider's mail-client setup documentation. */
  readonly helpUrl?: string;
  /** True when a normal password is rejected and an app password is required. */
  readonly requiresAppPassword?: boolean;
  /** True when the provider supports OAuth2 sign-in. */
  readonly oauth2Supported?: boolean;
  /** Free-form caveat shown to the user when configuring the account. */
  readonly notes?: string;
}

/** `[host, port, security]` — compact endpoint tuple used by `preset()`. */
type Endpoint = [host: string, port: number, security: TransportSecurity];

interface PresetExtras {
  help?: string;
  appPassword?: true;
  oauth2?: true;
  note?: string;
}

const ICON_BASE = 'https://cdn.jsdelivr.net/npm/simple-icons@v10/icons';
/** Build a Simple Icons CDN URL for the given slug. */
const si = (slug: string): string => `${ICON_BASE}/${slug}.svg`;

/**
 * Assemble an {@link EmailProvider}. Optional auth/help fields are only set
 * when supplied, so consumers can rely on `undefined` (rather than `false`)
 * for "not applicable" — matching how the presets are read elsewhere.
 */
function preset(
  id: string,
  name: string,
  displayName: string,
  iconUrl: string,
  color: string,
  imap: Endpoint,
  smtp: Endpoint | null,
  domains: string[],
  extras: PresetExtras = {},
): EmailProvider {
  const [imapHost, imapPort, imapSecurity] = imap;
  return {
    id,
    name,
    displayName,
    iconUrl,
    color,
    imapHost,
    imapPort,
    imapSecurity,
    domains,
    ...(smtp ? { smtpHost: smtp[0], smtpPort: smtp[1], smtpSecurity: smtp[2] } : {}),
    ...(extras.help ? { helpUrl: extras.help } : {}),
    ...(extras.appPassword ? { requiresAppPassword: true as const } : {}),
    ...(extras.oauth2 ? { oauth2Supported: true as const } : {}),
    ...(extras.note ? { notes: extras.note } : {}),
  };
}

/**
 * Built-in provider catalog. Grouping is for readability only; order is not
 * significant to callers. To add a preset, append a `preset(...)` call with a
 * unique `id` and the address `domains` you want auto-detected.
 */
export const emailProviders: EmailProvider[] = [
  // Major consumer webmail
  preset('gmail', 'Gmail', 'Google Mail', si('gmail'), '#EA4335',
    ['imap.gmail.com', 993, 'SSL'], ['smtp.gmail.com', 465, 'SSL'],
    ['gmail.com', 'googlemail.com'],
    { help: 'https://support.google.com/mail/answer/7126229', appPassword: true, oauth2: true,
      note: 'Use an app password (with 2-step verification enabled) or OAuth2; basic password login is disabled by Google.' }),

  preset('outlook', 'Outlook', 'Microsoft Outlook', si('microsoftoutlook'), '#0078D4',
    ['outlook.office365.com', 993, 'TLS'], ['smtp-mail.outlook.com', 587, 'STARTTLS'],
    ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    { help: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353', oauth2: true }),

  preset('yahoo', 'Yahoo', 'Yahoo Mail', si('yahoo'), '#6001D2',
    ['imap.mail.yahoo.com', 993, 'SSL'], ['smtp.mail.yahoo.com', 465, 'SSL'],
    ['yahoo.com', 'yahoo.de', 'yahoo.co.uk', 'ymail.com'],
    { help: 'https://help.yahoo.com/kb/SLN4075.html', appPassword: true,
      note: 'Generate an app password under Yahoo Account Security; your normal password will not work for IMAP.' }),

  preset('icloud', 'iCloud', 'Apple iCloud Mail', si('icloud'), '#007AFF',
    ['imap.mail.me.com', 993, 'SSL'], ['smtp.mail.me.com', 587, 'STARTTLS'],
    ['icloud.com', 'me.com', 'mac.com'],
    { help: 'https://support.apple.com/en-us/HT202304', appPassword: true,
      note: 'With two-factor authentication on, create an app-specific password to sign in.' }),

  preset('aol', 'AOL', 'AOL Mail', si('aol'), '#FF0B00',
    ['imap.aol.com', 993, 'SSL'], ['smtp.aol.com', 465, 'SSL'],
    ['aol.com', 'aol.de'],
    { help: 'https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail', appPassword: true }),

  // Microsoft 365 (business)
  preset('office365', 'Office365', 'Microsoft 365', si('microsoft365'), '#0078D4',
    ['outlook.office365.com', 993, 'TLS'], ['smtp.office365.com', 587, 'STARTTLS'],
    [],
    { help: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353', oauth2: true,
      note: 'For business/organization accounts; authenticate with the full email address as the username.' }),

  // Privacy-focused providers
  preset('protonmail', 'ProtonMail', 'Proton Mail', si('protonmail'), '#6D4AFF',
    ['127.0.0.1', 1143, 'STARTTLS'], ['127.0.0.1', 1025, 'STARTTLS'],
    ['protonmail.com', 'proton.me', 'pm.me'],
    { help: 'https://proton.me/support/protonmail-bridge-install',
      note: 'Requires the Proton Mail Bridge running locally (paid plans only); host and port point at the bridge.' }),

  preset('posteo', 'Posteo', 'Posteo', 'https://posteo.de/favicon.ico', '#8CC63F',
    ['posteo.de', 993, 'TLS'], ['posteo.de', 587, 'STARTTLS'],
    ['posteo.de', 'posteo.net'],
    { help: 'https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp' }),

  preset('mailbox', 'Mailbox.org', 'mailbox.org', 'https://mailbox.org/favicon.ico', '#5CB85C',
    ['imap.mailbox.org', 993, 'TLS'], ['smtp.mailbox.org', 587, 'STARTTLS'],
    ['mailbox.org'],
    { help: 'https://kb.mailbox.org/en/private/e-mail-article/manual-configuration-of-e-mail-programs' }),

  // Independent / premium
  preset('fastmail', 'Fastmail', 'Fastmail', si('fastmail'), '#2E5CFF',
    ['imap.fastmail.com', 993, 'SSL'], ['smtp.fastmail.com', 465, 'SSL'],
    ['fastmail.com', 'fastmail.fm'],
    { help: 'https://www.fastmail.help/hc/en-us/articles/1500000278342', appPassword: true,
      note: 'Create an app password under Settings → Privacy & Security; the master password is not accepted for IMAP.' }),

  preset('zoho', 'Zoho', 'Zoho Mail', si('zoho'), '#C83C2B',
    ['imap.zoho.com', 993, 'SSL'], ['smtp.zoho.com', 465, 'SSL'],
    ['zoho.com', 'zohomail.com'],
    { help: 'https://www.zoho.com/mail/help/imap-access.html',
      note: 'Turn on IMAP access in Zoho Mail settings before connecting.' }),

  // German / EU ISPs
  preset('gmx', 'GMX', 'GMX Mail', 'https://upload.wikimedia.org/wikipedia/commons/4/4e/GMX_logo.svg', '#FF6900',
    ['imap.gmx.net', 993, 'SSL'], ['mail.gmx.net', 587, 'STARTTLS'],
    ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.com'],
    { help: 'https://support.gmx.com/pop-imap/imap/index.html' }),

  preset('webde', 'Web.de', 'WEB.DE Mail', 'https://upload.wikimedia.org/wikipedia/commons/f/f2/Web.de_logo.svg', '#FFCC00',
    ['imap.web.de', 993, 'SSL'], ['smtp.web.de', 587, 'STARTTLS'],
    ['web.de'],
    { help: 'https://hilfe.web.de/pop-imap/imap/index.html' }),

  preset('ionos', 'IONOS', 'IONOS Mail (1&1)', si('ionos'), '#003D8F',
    ['imap.ionos.de', 993, 'SSL'], ['smtp.ionos.de', 587, 'STARTTLS'],
    ['ionos.de', '1und1.de', '1and1.com'],
    { help: 'https://www.ionos.de/hilfe/e-mail/e-mail-konto-in-e-mail-programm-einrichten/imap-posteingangsserver-und-postausgangsserver/',
      note: 'Sign in with your full email address as the username.' }),

  // Generic hosting
  preset('hostinger', 'Hostinger', 'Hostinger Email', '/images/providers/hostinger_logo.svg', '#673AB7',
    ['imap.hostinger.com', 993, 'TLS'], ['smtp.hostinger.com', 465, 'TLS'],
    [],
    { help: 'https://support.hostinger.com/en/articles/1583419-how-to-set-up-an-email-account-on-an-email-client',
      note: 'For mailboxes hosted on Hostinger; use the full email address as the username.' }),

  // Manual fallback (receive-only template; no SMTP defaults)
  preset('custom', 'Custom', 'Custom/Other Provider', si('mail'), '#6B7280',
    ['', 993, 'SSL'], null,
    [],
    { note: "Enter your provider's IMAP and SMTP settings manually." }),
];

/** Lower-cased domain portion of an email address, or undefined if malformed. */
function domainOf(address: string): string | undefined {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return undefined;
  return address.slice(at + 1).toLowerCase();
}

/**
 * Resolve a provider preset from an email address by matching its domain
 * against each provider's `domains` list. A provider matches when the address
 * domain ends with one of its listed domains (so subdomains resolve too).
 * Presets with no domains (e.g. custom/business) are never auto-matched.
 */
export function getProviderByEmail(address: string): EmailProvider | undefined {
  const domain = domainOf(address);
  if (domain === undefined) {
    return undefined;
  }
  return emailProviders.find((provider) =>
    provider.domains.some((known) => domain.endsWith(known)));
}

/** Resolve a provider preset by its stable `id`. */
export function getProviderById(providerId: string): EmailProvider | undefined {
  return emailProviders.find((provider) => provider.id === providerId);
}
