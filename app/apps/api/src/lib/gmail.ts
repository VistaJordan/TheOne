// Outgoing email through Gmail (Google Workspace) — the shared mailbox
// contact@seamlessfm.com lives on Gmail, not Microsoft 365 (Elise,
// 2026-10-13).
//
// No SDK: a Google service account signs a JWT (RS256, node:crypto) asking to
// act AS the mailbox (`sub`) with the gmail.send scope; Google trades it for
// an access token, and the message goes to `users/me/messages/send` as one
// base64url MIME document. That needs, once, in the Google Workspace admin
// console: Security › API controls › Domain-wide delegation › add the service
// account's client id with scope https://www.googleapis.com/auth/gmail.send.
// The sent copy lands in the mailbox's Sent folder like any other mail.
//
// `buildMime` is pure (tests/gmail.test.ts pins its shape).

import { createSign, randomBytes } from 'node:crypto';

export interface GmailCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface MimeMessage {
  from: string;
  fromName: string;
  replyTo: string | null;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A header value outside ASCII as an RFC 2047 encoded word. */
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** Base64 body wrapped at 76 characters, as MIME wants it. */
const wrap64 = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n');

/** A display name safe inside a quoted header phrase. */
const phrase = (s: string) => `"${encodeWord(s).replace(/["\\]/g, '')}"`;

export function buildMime(m: MimeMessage, boundarySeed = randomBytes(12).toString('hex')): string {
  const mixed = `mixed_${boundarySeed}`;
  const alt = `alt_${boundarySeed}`;
  const head = [
    `From: ${phrase(m.fromName)} <${m.from}>`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap64(Buffer.from(m.text, 'utf8')),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap64(Buffer.from(m.html, 'utf8')),
    `--${alt}--`,
  ];
  for (const a of m.attachments) {
    const name = encodeWord(a.filename).replace(/"/g, '');
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap64(a.content),
    );
  }
  parts.push(`--${mixed}--`, '');
  return [...head, '', ...parts].join('\r\n');
}

/** GMAIL_SERVICE_ACCOUNT_JSON (the key file as downloaded), or
    GMAIL_SERVICE_ACCOUNT_EMAIL + GMAIL_PRIVATE_KEY (newlines as \n). */
export function gmailCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): GmailCredentials | null {
  const json = env.GMAIL_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    try {
      const k = JSON.parse(json) as { client_email?: string; private_key?: string };
      if (k.client_email && k.private_key) return { clientEmail: k.client_email, privateKey: k.private_key };
    } catch {
      return null;
    }
  }
  const email = env.GMAIL_SERVICE_ACCOUNT_EMAIL?.trim();
  const key = env.GMAIL_PRIVATE_KEY?.trim();
  return email && key ? { clientEmail: email, privateKey: key.replace(/\\n/g, '\n') } : null;
}

let token: { mailbox: string; value: string; expiresAt: number } | null = null;

async function accessToken(c: GmailCredentials, mailbox: string): Promise<string> {
  if (token && token.mailbox === mailbox && token.expiresAt > Date.now() + 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: c.clientEmail,
      sub: mailbox,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(c.privateKey))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    const why = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    throw new Error(
      json.error === 'unauthorized_client'
        ? `Google refused to let the service account send as ${mailbox}: add its client id with the gmail.send scope under Domain-wide delegation in the Workspace admin console.`
        : `Google sign-in for email failed: ${why}`,
    );
  }
  token = { mailbox, value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3000) * 1000 };
  return token.value;
}

export async function sendViaGmail(c: GmailCredentials, m: MimeMessage): Promise<{ messageId: string | null }> {
  const t = await accessToken(c, m.from);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(buildMime(m)) }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`Gmail could not send the email: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return { messageId: json.id ?? null };
}
