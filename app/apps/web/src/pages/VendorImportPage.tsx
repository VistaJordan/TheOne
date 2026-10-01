/* /vendors/import — bring a spreadsheet of vendors or technicians in (0058).

   Four steps on one page, each unlocked by the one before:
     1  pick the CSV — parsed here in the browser (lib/csv.ts)
     2  say which column is which — recognised headers are matched already
     3  check — the API reads every row and reports what it would do,
        writing nothing
     4  run — rows go up in chunks of 200 so a long file shows progress and a
        dropped connection loses one chunk, not the run

   Nothing is guessed: a cell that cannot be read is reported beside its row,
   and duplicates follow the rule picked in step 3. */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IMPORTABLE_VENDOR_FIELDS,
  IMPORT_DUPLICATE_LABELS,
  IMPORT_MAX_ROWS,
  VENDOR_KIND_LABELS,
  autoMapImportColumns,
} from '@theone/shared';
import type { ImportAnalysis, ImportDuplicateStrategy, ImportMissingStrategy, ImportSummary, VendorKind } from '@theone/shared';
import {
  ApiRequestError,
  analyzeVendorImport,
  getVendorImports,
  getVendorsMeta,
  sendVendorImportRows,
  startVendorImport,
} from '../api/client';
import type { ImportCsvRow } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { parseCsv, readFileText } from '../lib/csv';

const CHUNK = 200;
const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

interface Loaded {
  fileName: string;
  headers: string[];
  rows: ImportCsvRow[];
}

export function VendorImportPage() {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['vendors-meta'], queryFn: getVendorsMeta });
  const history = useQuery({ queryKey: ['vendor-imports'], queryFn: getVendorImports });

  const [file, setFile] = useState<Loaded | null>(null);
  const [kind, setKind] = useState<VendorKind>('vendor');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [brand, setBrand] = useState('');
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [dupes, setDupes] = useState<ImportDuplicateStrategy>('FLAG');
  const [missing, setMissing] = useState<ImportMissingStrategy>('ADD');
  const [busy, setBusy] = useState<'reading' | 'checking' | 'running' | null>(null);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only the mapped columns travel: the body stays small and nothing the user
  // did not map leaves the browser.
  const cleanMapping = useMemo(() => Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)), [mapping]);
  const sendRows = useMemo(() => {
    if (!file) return [];
    const keep = Object.keys(cleanMapping);
    return file.rows.map((r) => Object.fromEntries(keep.map((h) => [h, r[h] ?? ''])));
  }, [file, cleanMapping]);
  const hasName = Object.values(cleanMapping).includes('name');

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setAnalysis(null);
    setSummary(null);
    setBusy('reading');
    try {
      const parsed = parseCsv(await readFileText(f));
      const headers = parsed.headers.filter((h) => h.trim() !== '');
      if (headers.length === 0 || parsed.rows.length === 0) throw new Error('That file has no rows. Save the sheet as CSV and try again.');
      if (parsed.rows.length > IMPORT_MAX_ROWS) throw new Error(`That file has ${parsed.rows.length} rows. Import at most ${IMPORT_MAX_ROWS} at a time — split the file.`);
      const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ''])));
      setFile({ fileName: f.name, headers, rows });
      setMapping(autoMapImportColumns(headers));
    } catch (e) {
      setFile(null);
      setError(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setBusy(null);
    }
  };

  const setCol = (header: string, field: string) => {
    setAnalysis(null);
    setMapping((cur) => ({ ...cur, [header]: field }));
  };

  const check = async () => {
    setError(null);
    setBusy('checking');
    try {
      const r = await analyzeVendorImport({ rows: sendRows, mapping: cleanMapping, kind });
      setAnalysis(r.analysis);
    } catch (e) {
      setError(errText(e, 'Could not check the file.'));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!file) return;
    setError(null);
    setBusy('running');
    setProgress(0);
    try {
      const { id } = await startVendorImport({
        file_name: file.fileName,
        kind,
        total_rows: sendRows.length,
        mapping: cleanMapping,
        duplicate_strategy: dupes,
        missing_strategy: missing,
      });
      let last: ImportSummary | null = null;
      for (let offset = 0; offset < sendRows.length; offset += CHUNK) {
        const r = await sendVendorImportRows(id, { offset, rows: sendRows.slice(offset, offset + CHUNK), brand_source: brand || null });
        last = r.summary;
        setProgress(Math.min(sendRows.length, offset + CHUNK));
      }
      setSummary(last);
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      void qc.invalidateQueries({ queryKey: ['vendors-meta'] });
      void qc.invalidateQueries({ queryKey: ['vendor-imports'] });
      void qc.invalidateQueries({ queryKey: ['vendor-tasks'] });
    } catch (e) {
      setError(`${errText(e, 'The import stopped.')} Rows already sent were saved; the rest were not.`);
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setMapping({});
    setAnalysis(null);
    setSummary(null);
    setError(null);
  };

  return (
    <AppShell active="Vendors">
      <div className="canvas-inner vimp">
        <div className="vend-head">
          <Link className="btn btn-sm is-ghost" to="/vendors">
            <Icon name="arrow-l" size={12} /> Vendors
          </Link>
          <div className="page-head" style={{ margin: 0 }}>
            <h1 className="page-title">Import vendors</h1>
          </div>
        </div>

        {error && (
          <div className="tmap-banner is-warn" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}

        {summary ? (
          <section className="card vimp-card">
            <h2 className="vimp-h"><Icon name="check-circle" size={16} /> Import finished</h2>
            <SummaryGrid s={summary} />
            <div className="vimp-actions">
              {summary.report.length > 0 && (
                <button type="button" className="btn" onClick={() => downloadReport(summary, file?.fileName ?? 'import')}>
                  <Icon name="download" size={14} /> Download the duplicates report ({summary.report.length})
                </button>
              )}
              <Link className="btn btn-primary" to="/vendors">Open the list</Link>
              <button type="button" className="btn is-ghost" onClick={reset}>Import another file</button>
            </div>
          </section>
        ) : (
          <>
            <section className="card vimp-card">
              <h2 className="vimp-h"><span className="vimp-n">1</span> The file</h2>
              <div className="vimp-row">
                <div className="seg" role="group" aria-label="What the file holds">
                  {(['vendor', 'tech'] as VendorKind[]).map((k) => (
                    <button key={k} type="button" className={`seg-btn${kind === k ? ' is-on' : ''}`} aria-pressed={kind === k} disabled={busy !== null} onClick={() => { setKind(k); setAnalysis(null); }}>
                      {VENDOR_KIND_LABELS[k]}s
                    </button>
                  ))}
                </div>
                <label className="btn">
                  <Icon name="upload" size={14} />
                  {file ? 'Choose another CSV' : 'Choose a CSV'}
                  <input type="file" accept=".csv,text/csv" hidden disabled={busy !== null} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {file && <span className="vimp-file"><b>{file.fileName}</b> · {file.rows.length} rows · {file.headers.length} columns</span>}
                {busy === 'reading' && <span className="vimp-file">Reading…</span>}
              </div>
              <p className="vimp-hint">Save the spreadsheet as CSV first. One row per {kind === 'vendor' ? 'vendor' : 'technician'}, the first row holding the column names. Up to {IMPORT_MAX_ROWS} rows per file.</p>
            </section>

            {file && (
              <section className="card vimp-card">
                <h2 className="vimp-h"><span className="vimp-n">2</span> Which column is which</h2>
                <div className="vimp-map">
                  {file.headers.map((h) => (
                    <label key={h} className="vimp-col">
                      <span className="vimp-col-h" title={h}>{h}</span>
                      <span className="vimp-col-eg">{file.rows.slice(0, 3).map((r) => r[h]).filter(Boolean).join(' · ') || '—'}</span>
                      <select className="fld" value={mapping[h] ?? ''} disabled={busy !== null} onChange={(e) => setCol(h, e.target.value)}>
                        <option value="">Leave out</option>
                        {IMPORTABLE_VENDOR_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                {kind === 'vendor' && (
                  <label className="vimp-row vimp-brand">
                    <span>Brand source for rows that name none</span>
                    <select className="fld" value={brand} onChange={(e) => setBrand(e.target.value)} disabled={busy !== null}>
                      <option value="">None</option>
                      {(meta.data?.brand_sources ?? []).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                    </select>
                  </label>
                )}
                <div className="vimp-actions">
                  <button type="button" className="btn btn-primary" disabled={!hasName || busy !== null} onClick={() => void check()}>
                    {busy === 'checking' ? 'Checking…' : 'Check the file'}
                  </button>
                  {!hasName && <span className="vimp-hint">Pick the column that holds the name.</span>}
                </div>
              </section>
            )}

            {file && analysis && (
              <section className="card vimp-card">
                <h2 className="vimp-h"><span className="vimp-n">3</span> What will happen</h2>
                <div className="vimp-stats">
                  <Stat n={analysis.total} label="rows" />
                  <Stat n={analysis.ready} label="ready" tone="ok" />
                  <Stat n={analysis.duplicates} label="already on file" tone={analysis.duplicates ? 'warn' : undefined} />
                  <Stat n={analysis.missing_required} label="missing required fields" tone={analysis.missing_required ? 'warn' : undefined} />
                  <Stat n={analysis.with_errors} label="with unreadable cells" tone={analysis.with_errors ? 'warn' : undefined} />
                  <Stat n={analysis.no_name} label="without a name (left out)" tone={analysis.no_name ? 'danger' : undefined} />
                </div>
                {analysis.samples.length > 0 && (
                  <ul className="vimp-samples">
                    {analysis.samples.map((s) => (
                      <li key={s.row}><b>Row {s.row}{s.name ? ` · ${s.name}` : ''}</b> {s.problems.join('; ')}</li>
                    ))}
                  </ul>
                )}
                {analysis.duplicates > 0 && (
                  <fieldset className="vimp-choice">
                    <legend>Rows that match a record already on file (same name or phone)</legend>
                    {(Object.keys(IMPORT_DUPLICATE_LABELS) as ImportDuplicateStrategy[]).map((k) => (
                      <label key={k}><input type="radio" name="dupes" checked={dupes === k} onChange={() => setDupes(k)} disabled={busy !== null} /> {IMPORT_DUPLICATE_LABELS[k]}</label>
                    ))}
                  </fieldset>
                )}
                {analysis.missing_required > 0 && (
                  <fieldset className="vimp-choice">
                    <legend>Rows missing a required field</legend>
                    <label><input type="radio" name="missing" checked={missing === 'ADD'} onChange={() => setMissing('ADD')} disabled={busy !== null} /> Add them, flagged for review</label>
                    <label><input type="radio" name="missing" checked={missing === 'SKIP'} onChange={() => setMissing('SKIP')} disabled={busy !== null} /> Leave them out</label>
                  </fieldset>
                )}
                <p className="vimp-hint">An unreadable cell is left empty; the rest of its row is still imported.</p>
                <div className="vimp-actions">
                  <button type="button" className="btn btn-primary" disabled={busy !== null || analysis.total === analysis.no_name} onClick={() => void run()}>
                    {busy === 'running' ? `Importing… ${progress} of ${sendRows.length}` : `Import ${analysis.total - analysis.no_name} rows`}
                  </button>
                  {busy === 'running' && <progress className="vimp-progress" value={progress} max={sendRows.length} />}
                </div>
              </section>
            )}
          </>
        )}

        <section className="card vimp-card">
          <h2 className="vimp-h">Earlier imports</h2>
          {(history.data?.imports ?? []).length === 0 ? (
            <div className="empty-flat">{history.isLoading ? 'Loading…' : 'No imports yet.'}</div>
          ) : (
            <div className="vend-wrap">
              <table className="vend-table">
                <thead>
                  <tr><th>When</th><th>File</th><th>By</th><th>Rows</th><th>Added</th><th>Filled in</th><th>Left out</th><th>Flagged</th></tr>
                </thead>
                <tbody>
                  {history.data!.imports.map((i) => (
                    <tr key={i.id}>
                      <td>{new Date(i.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                      <td>{i.file_name} <span className="chip chip-sm">{VENDOR_KIND_LABELS[i.kind]}s</span></td>
                      <td>{i.uploaded_by?.name ?? '—'}</td>
                      <td className="num">{i.total_rows}</td>
                      <td className="num">{i.summary.created ?? 0}</td>
                      <td className="num">{i.summary.enriched ?? 0}</td>
                      <td className="num">{(i.summary.skipped_duplicates ?? 0) + (i.summary.skipped_missing ?? 0) + (i.summary.skipped_invalid ?? 0)}</td>
                      <td className="num">{(i.summary.flagged_duplicates ?? 0) + (i.summary.flagged_missing ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={`vimp-stat${tone ? ` is-${tone}` : ''}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function SummaryGrid({ s }: { s: ImportSummary }) {
  return (
    <div className="vimp-stats">
      <Stat n={s.created} label="added" tone="ok" />
      <Stat n={s.enriched} label="records filled in" />
      <Stat n={s.skipped_duplicates} label="duplicates left out" />
      <Stat n={s.skipped_missing} label="left out — missing fields" />
      <Stat n={s.skipped_invalid} label="left out — no name" />
      <Stat n={s.flagged_duplicates} label="flagged as possible duplicates" tone={s.flagged_duplicates ? 'warn' : undefined} />
      <Stat n={s.flagged_missing} label="flagged — missing information" tone={s.flagged_missing ? 'warn' : undefined} />
      <Stat n={s.not_on_map} label="not on the map" tone={s.not_on_map ? 'warn' : undefined} />
    </div>
  );
}

const csvCell = (v: string | number | null) => {
  const s = String(v ?? '');
  // A leading = + - @ would run as a formula when the report is opened.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function downloadReport(s: ImportSummary, fileName: string) {
  const lines = [
    ['Row', 'Name', 'Phone', 'Record on file', 'Link'].join(','),
    ...s.report.map((r) => [r.row, r.name, r.phone, r.existing_name, `${window.location.origin}/vendors/${r.existing_id}`].map(csvCell).join(',')),
  ];
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName.replace(/\.csv$/i, '')}-duplicates.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
