// Outbound email (0055) — the first thing in the app that sends mail.
//
// One port, two providers, both plain fetch (no SDK, nothing extra for the
// Vercel bundle):
//
//   graph   Microsoft Graph `POST /users/{from}/sendMail`, app-only token by
//           client credentials. The mailbox is MAIL_FROM (contact@
//           seamlessfm.com), so the sent copy lands in its Sent Items. Needs
//           the Mail.Send APPLICATION permission granted to the registration.
//   resend  Resend's `POST /emails`; the MAIL_FROM domain must be verified.
//
// With neither configured `sendEmail` throws a MailNotConfigured error the
// caller turns into a failed delivery row and a clear message — nothing is
// queued to go out later by surprise.

import type { MailStatus } from '@theone/shared';
import { config } from '../config.js';
import { integrationOn } from './integrations.js';

export interface MailAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes (a CSV as a UTF-8 Buffer). */
  content: Buffer;
}

export interface OutboundEmail {
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

export interface SentEmail {
  provider: 'graph' | 'resend';
  messageId: string | null;
}

export class MailNotConfiguredError extends Error {
  constructor(reason: 'unconfigured' | 'off' = 'unconfigured') {
    super(
      reason === 'off'
        ? 'Outgoing email is switched off in Admin › Integrations. Nothing was sent.'
        : 'Email is not set up yet: no mail provider is configured on the server (MAIL_PROVIDER). ' +
          'Nothing was sent.',
    );
  }
}

/** Provider present AND the switch in Admin › Integrations on (0074). */
export function mailStatus(): MailStatus {
  return { configured: config.mail.provider !== null && integrationOn('email'), provider: config.mail.provider, from: config.mail.from };
}

export async function sendEmail(msg: OutboundEmail): Promise<SentEmail> {
  if (msg.to.length === 0) throw new Error('An email needs at least one recipient');
  if (!integrationOn('email')) throw new MailNotConfiguredError('off');
  switch (config.mail.provider) {
    case 'graph':
      return sendViaGraph(msg);
    case 'resend':
      return sendViaResend(msg);
    default:
      throw new MailNotConfiguredError();
  }
}

// ── Microsoft Graph ──────────────────────────────────────────────────────────

let graphToken: { value: string; expiresAt: number } | null = null;

async function graphAccessToken(): Promise<string> {
  if (graphToken && graphToken.expiresAt > Date.now() + 60_000) return graphToken.value;
  const g = config.mail.graph;
  if (!g) throw new MailNotConfiguredError();
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(g.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Microsoft sign-in for email failed: ${firstLine(json.error_description) ?? res.status}`);
  }
  graphToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3000) * 1000 };
  return graphToken.value;
}

async function sendViaGraph(msg: OutboundEmail): Promise<SentEmail> {
  const token = await graphAccessToken();
  const rcpt = (a: string) => ({ emailAddress: { address: a } });
  const message = {
    subject: msg.subject,
    body: { contentType: 'HTML', content: msg.html },
    toRecipients: msg.to.map(rcpt),
    ccRecipients: msg.cc.map(rcpt),
    ...(config.mail.replyTo ? { replyTo: [rcpt(config.mail.replyTo)] } : {}),
    attachments: (msg.attachments ?? []).map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType,
      contentBytes: a.content.toString('base64'),
    })),
  };
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mail.from)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  );
  if (res.status !== 202 && !res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const why = json.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 403) {
      throw new Error(`Microsoft refused to send as ${config.mail.from} (${firstLine(why)}). The app registration needs the Mail.Send application permission.`);
    }
    throw new Error(`Microsoft could not send the email: ${firstLine(why)}`);
  }
  return { provider: 'graph', messageId: res.headers.get('request-id') };
}

// ── Resend ───────────────────────────────────────────────────────────────────

async function sendViaResend(msg: OutboundEmail): Promise<SentEmail> {
  const key = config.mail.resendApiKey;
  if (!key) throw new MailNotConfiguredError();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${config.mail.fromName} <${config.mail.from}>`,
      to: msg.to,
      cc: msg.cc.length ? msg.cc : undefined,
      reply_to: config.mail.replyTo ?? undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`The email service refused the message: ${firstLine(json.message) ?? `HTTP ${res.status}`}`);
  return { provider: 'resend', messageId: json.id ?? null };
}

function firstLine(s: string | undefined): string | undefined {
  return s ? s.split(/\r?\n/)[0].slice(0, 300) : undefined;
}
