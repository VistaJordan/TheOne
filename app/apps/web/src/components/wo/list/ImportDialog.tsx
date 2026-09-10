import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportResult, WoFieldDescriptor } from '../../../api/client';
import { importWorkOrders } from '../../../api/client';
import { headerKey, parseCsv, readFileText } from '../../../lib/csv';
import { Icon } from '../../Icon';

interface ImportDialogProps {
  fields: WoFieldDescriptor[];
  onClose: () => void;
}

/** Field keys the import understands that are not in the catalogue as such —
    the two that are matched BY NAME rather than written as a value. */
const EXTRA_TARGETS: WoFieldDescriptor[] = [
  { key: 'wo_number', label: 'WO # (match key)', type: 'text', group: 'Work order', sortable: false },
  { key: 'status', label: 'Status (by name)', type: 'text', group: 'Status', sortable: false },
  { key: 'home_list', label: 'Home list (by name)', type: 'text', group: 'Routing', sortable: false },
];

/** Columns an import can actually write. Everything else in the catalogue is
    derived (`age_days`) or maintained by the app (`created_at`). */
const WRITABLE = new Set([
  'ext_name',
  'title',
  'description',
  'client',
  'city',
  'state',
  'trade',
  'billing_entity',
  'nte',
  'priority',
  'date_received',
]);

/**
 * Import work orders from a CSV.
 *
 * Three steps, in the order the questions actually arise: pick the file, say
 * what its columns mean, then look at what the import WOULD do before it does
 * it. The dry run is not optional — a spreadsheet from a client is exactly the
 * kind of input whose damage you want to read before it lands.
 */
export function ImportDialog({ fields, onClose }: ImportDialogProps) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<'upsert' | 'create'>('upsert');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targets = useMemo(() => {
    const writable = fields.filter((f) => WRITABLE.has(f.key) || f.custom);
    return [...EXTRA_TARGETS, ...writable];
  }, [fields]);

  /** Guess the mapping from the header text. Most exports name their columns
      recognisably, so the common case is a mapping the user only checks. */
  const autoMap = (hdrs: string[]): Record<number, string> => {
    const byNorm = new Map<string, string>();
    for (const t of targets) {
      byNorm.set(headerKey(t.label), t.key);
      byNorm.set(headerKey(t.key.replace(/^fields\./, '')), t.key);
    }
    const out: Record<number, string> = {};
    hdrs.forEach((h, i) => {
      const hit = byNorm.get(headerKey(h));
      if (hit) out[i] = hit;
    });
    return out;
  };

  const onFile = async (file: File) => {
    setError(null);
    setPreview(null);
    try {
      const parsed = parseCsv(await readFileText(file));
      if (parsed.headers.length === 0) {
        setError('That file has no header row.');
        return;
      }
      setFileName(file.name);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setMapping(autoMap(parsed.headers));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  };

  const buildRows = (): Record<string, string | null>[] =>
    rows.map((r) => {
      const obj: Record<string, string | null> = {};
      for (const [idx, key] of Object.entries(mapping)) {
        if (!key) continue;
        obj[key] = r[Number(idx)] ?? '';
      }
      return obj;
    });

  const run = useMutation({
    mutationFn: (dry: boolean) =>
      importWorkOrders({ rows: buildRows(), mode, dry_run: dry }),
    onError: (e: Error) => setError(e.message || 'The import failed'),
  });

  const runDry = () => {
    setError(null);
    run.mutate(true, { onSuccess: (res) => setPreview(res) });
  };

  const commit = () => {
    setError(null);
    run.mutate(false, {
      onSuccess: (res) => {
        setPreview(res);
        qc.invalidateQueries({ queryKey: ['work-orders'] });
        qc.invalidateQueries({ queryKey: ['kpis'] });
      },
    });
  };

  const mapped = Object.values(mapping).filter(Boolean).length;
  const committed = preview !== null && !preview.dry_run;

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal is-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Import work orders"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Import work orders</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* 1 · the file */}
          <section className="import-step">
            <h3>
              <span className="step-n">1</span> Choose a CSV
            </h3>
            <div className="import-file">
              <button type="button" className="btn-sm" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={14} />
                {fileName ? 'Choose a different file' : 'Choose file'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = '';
                }}
              />
              {fileName && (
                <span className="import-filename">
                  {fileName} — {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'},{' '}
                  {headers.length} column{headers.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </section>

          {/* 2 · the mapping */}
          {headers.length > 0 && (
            <section className="import-step">
              <h3>
                <span className="step-n">2</span> Match the columns
              </h3>
              <p className="import-hint">
                A row with a WO&nbsp;# that already exists updates that work order; anything else
                creates a new one. Unmatched columns are ignored.
              </p>
              <div className="map-grid">
                {headers.map((h, i) => (
                  <div className="map-row" key={`${h}-${i}`}>
                    <span className="map-src ellipsis" title={h}>
                      {h || <em>(unnamed)</em>}
                    </span>
                    <span className="map-arrow" aria-hidden="true">
                      <Icon name="arrow-r" size={12} />
                    </span>
                    <select
                      value={mapping[i] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })}
                      aria-label={`Map column ${h}`}
                    >
                      <option value="">Ignore this column</option>
                      {targets.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <span className="map-sample ellipsis" title={rows[0]?.[i] ?? ''}>
                      {rows[0]?.[i] ?? ''}
                    </span>
                  </div>
                ))}
              </div>

              <div className="import-mode">
                <label className="check-row">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === 'upsert'}
                    onChange={() => setMode('upsert')}
                  />
                  <span>
                    Create and update
                    <small>Existing WO&nbsp;#s are updated in place.</small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === 'create'}
                    onChange={() => setMode('create')}
                  />
                  <span>
                    Only create
                    <small>Rows matching an existing WO&nbsp;# are skipped.</small>
                  </span>
                </label>
              </div>
            </section>
          )}

          {/* 3 · the dry run */}
          {preview && (
            <section className="import-step">
              <h3>
                <span className="step-n">3</span>{' '}
                {committed ? 'Imported' : 'What this import will do'}
              </h3>
              <div className="import-tally">
                <span className="tally is-ok">{preview.created} to create</span>
                <span className="tally is-ok">{preview.updated} to update</span>
                {preview.skipped > 0 && <span className="tally">{preview.skipped} skipped</span>}
                {preview.errored > 0 && (
                  <span className="tally is-err">{preview.errored} with errors</span>
                )}
              </div>
              {preview.errored > 0 && (
                <ul className="import-errors">
                  {preview.rows
                    .filter((r) => r.action === 'error')
                    .slice(0, 20)
                    .map((r) => (
                      <li key={r.row}>
                        <strong>Row {r.row}</strong>
                        {r.wo_number ? ` (${r.wo_number})` : ''} — {r.message}
                      </li>
                    ))}
                  {preview.errored > 20 && <li>…and {preview.errored - 20} more.</li>}
                </ul>
              )}
              {!committed && preview.errored > 0 && (
                <p className="import-hint">
                  Rows with errors are left out; the rest still import.
                </p>
              )}
            </section>
          )}

          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>
            {committed ? 'Done' : 'Cancel'}
          </button>
          {!committed && (
            <>
              <button
                type="button"
                className="btn-sm is-ghost"
                onClick={runDry}
                disabled={mapped === 0 || rows.length === 0 || run.isPending}
              >
                {run.isPending ? 'Checking…' : 'Preview'}
              </button>
              <button
                type="button"
                className="btn-sm"
                onClick={commit}
                // Nothing is written until a dry run has been read: the button
                // stays off until the preview is on screen.
                disabled={!preview || run.isPending}
                title={preview ? undefined : 'Run a preview first'}
              >
                {run.isPending
                  ? 'Importing…'
                  : `Import ${(preview ? preview.created + preview.updated : 0).toLocaleString()} row(s)`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
