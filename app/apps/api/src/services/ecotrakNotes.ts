// 0114 · Ecotrak comments → the work order's Messages, client-visible.
//
// READ ONLY against Ecotrak: one GET per work order (/v1/workorders/:id/note).
// Each note lands through receiveClientMessage (services/woMessages.ts), keyed
// by Ecotrak's own note id, so a note is filed once however many times it is
// read, and a note edited on Ecotrak is updated here. Nothing goes back: no
// client-message adapter is registered for Ecotrak (modules/integrations/
// clientMessages.ts), so what we post stays in our outbox, pending.

import { ecotrakNoteAuthor } from '@theone/shared';
import { query } from '../db.js';
import type { EcotrakClient } from '../modules/integrations/ecotrak/client.js';
import { receiveClientMessage } from './woMessages.js';

export interface NotesSyncResult {
  added: number;
  updated: number;
}

/** Read one work order's notes from Ecotrak and file the new or edited ones. */
export async function syncEcotrakNotes(
  client: EcotrakClient,
  connectionId: string,
  taskId: string,
  externalId: string,
): Promise<NotesSyncResult> {
  const notes = await client.fetchNotes(externalId);
  const out: NotesSyncResult = { added: 0, updated: 0 };
  // Oldest first, so the thread's order follows Ecotrak's when two land at once.
  notes.sort((a, b) => String(a.created_date ?? '').localeCompare(String(b.created_date ?? '')));
  for (const n of notes) {
    const body = String(n.description ?? '').trim();
    if (!body) continue;
    const r = await receiveClientMessage({
      task_id: taskId,
      target: 'ecotrak',
      external_id: String(n.id),
      external_author: ecotrakNoteAuthor(n),
      body,
      occurred_at: ecotrakTime(n.created_date),
    });
    if (r.created) out.added++;
    else if (r.updated) out.updated++;
  }
  await query(
    `UPDATE cmms_wo_link SET notes_synced_at = now() WHERE connection_id = $1 AND external_id = $2`,
    [connectionId, externalId],
  );
  return out;
}

/** Ecotrak writes "2025-03-13T20:24:34.428+0000"; Postgres wants "+00:00". */
function ecotrakTime(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Number.isNaN(Date.parse(s)) ? null : s;
}
