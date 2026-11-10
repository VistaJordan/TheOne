// 0131 · an integration starts from the moment it is turned on (Elise,
// 2026-11-10): nothing posted, approved or changed before that is sent or
// replayed when a connector goes live. Source pins — the suite opens no
// database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_MESSAGE_INTEGRATION, INTEGRATION_KEYS } from '@theone/shared';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

describe('0131 · integrations start when turned on', () => {
  it('maps every client system to a real switch', () => {
    for (const key of Object.values(CLIENT_MESSAGE_INTEGRATION)) {
      expect(INTEGRATION_KEYS as readonly string[]).toContain(key);
    }
    expect(CLIENT_MESSAGE_INTEGRATION.ecotrak).toBe('ecotrak_outbound');
  });

  it('the migration adds on_since, the skipped status, and skips what is queued today', () => {
    const sql = read('packages/db/migrations/0131_integrations_start_when_on.sql');
    expect(sql).toMatch(/ADD COLUMN on_since timestamptz/);
    expect(sql).toMatch(/'pending', 'sent', 'failed', 'skipped'/);
    expect(sql).toMatch(/SET status = 'skipped'[\s\S]*WHERE status = 'pending'/);
  });

  it('a message can only leave while its switch is on, and is skipped otherwise', () => {
    const port = read('apps/api/src/modules/integrations/clientMessages.ts');
    expect(port).toMatch(/adapters\.has\(target\) && integrationOn\(CLIENT_MESSAGE_INTEGRATION\[target\]\)/);
    const svc = read('apps/api/src/services/woMessages.ts');
    expect(svc).toMatch(/const skipped = !clientWriteEnabled\(target\)/);
    expect(svc).toMatch(/const pending = res\.rows\.filter\(\(r\) => clientWriteEnabled\(r\.target\)\)/);
    expect(svc).toMatch(/export async function skipQueuedDeliveries/);
  });

  it('turning a switch on stamps on_since and skips messages still queued', () => {
    const svc = read('apps/api/src/services/integrations.ts');
    expect(svc).toMatch(/on_since = CASE WHEN EXCLUDED\.enabled AND NOT integration_setting\.enabled THEN now\(\)/);
    expect(svc).toMatch(/skipQueuedDeliveries\(target\)/);
  });

  it('the SharePoint sweep files nothing from before the switch went on', () => {
    const svc = read('apps/api/src/services/sharepoint.ts');
    expect(svc).toMatch(/const onSince = await integrationOnSince\('sharepoint'\)/);
    for (const k of ['client_folders_since', 'wo_folders_since', 'copy_files_since']) {
      expect(svc).toContain(`[since(s.${k}), SWEEP_BATCH]`);
    }
  });

  it('webhooks are acknowledged and dropped while off, so no retry replays them', () => {
    const svc = read('apps/api/src/routes/webhooks.ts');
    expect(svc).toMatch(/if \(!integrationOn\('quo'\)\) return \{ ok: true, ignored: 'switched_off' \}/);
    expect(svc).toMatch(/if \(!integrationOn\('email_escalations'\)\) return \{ ok: true, ignored: 'switched_off' \}/);
    expect(svc).not.toMatch(/requireIntegration\('quo'\)/);
  });
});
