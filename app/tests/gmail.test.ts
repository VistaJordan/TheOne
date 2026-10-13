/* Outgoing email through Gmail: the MIME document sent to Gmail's API and
 * the credentials read from the environment. Sending itself needs Google and
 * is exercised against the real mailbox. */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildMime, gmailCredentialsFromEnv } from '../apps/api/src/lib/gmail';

const msg = {
  from: 'contact@seamlessfm.com',
  fromName: 'Seamless FM',
  replyTo: null,
  to: ['client@example.com'],
  cc: ['am@example.com'],
  subject: 'Weekly update — Café 7',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [{ filename: 'update.csv', contentType: 'text/csv', content: Buffer.from('a,b\n1,2\n') }],
};

describe('the MIME message', () => {
  const mime = buildMime(msg, 'seed');
  it('is from the shared mailbox, to and cc the recipients', () => {
    expect(mime).toContain('From: "Seamless FM" <contact@seamlessfm.com>');
    expect(mime).toContain('To: client@example.com');
    expect(mime).toContain('Cc: am@example.com');
  });
  it('encodes a subject outside ASCII', () => {
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from(msg.subject).toString('base64')}?=`);
  });
  it('carries text, html and the attachment', () => {
    expect(mime).toContain('multipart/alternative; boundary="alt_seed"');
    expect(mime).toContain(Buffer.from('<p>Hello</p>').toString('base64'));
    expect(mime).toContain('Content-Disposition: attachment; filename="update.csv"');
    expect(mime.trimEnd().endsWith('--mixed_seed--')).toBe(true);
  });
});

describe('credentials', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  it('reads the key file as downloaded', () => {
    const c = gmailCredentialsFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: pem }) });
    expect(c?.clientEmail).toBe('sa@x.iam.gserviceaccount.com');
  });
  it('reads the two-variable form with escaped newlines', () => {
    const c = gmailCredentialsFromEnv({ GMAIL_SERVICE_ACCOUNT_EMAIL: 'sa@x', GMAIL_PRIVATE_KEY: pem.replace(/\n/g, '\\n') });
    expect(c?.privateKey).toBe(pem);
  });
  it('is null when nothing is set', () => {
    expect(gmailCredentialsFromEnv({})).toBeNull();
  });
});
