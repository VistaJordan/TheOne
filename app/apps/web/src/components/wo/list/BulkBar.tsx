import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusGroup } from '@theone/shared';
import type { BulkUpdateResult, StatusWithPhase, WoFieldDescriptor } from '../../../api/client';
import {
  bulkDeleteWorkOrders,
  bulkUpdateWorkOrders,
  getStatuses,
  listRoutingLists,
} from '../../../api/client';
import { Icon } from '../../Icon';
import { ConfirmDialog } from '../../ConfirmDialog';
import { pillStyle } from '../../StatusPill';
import { Popover } from './Popover';
import { FieldPicker } from './FieldPicker';

const GROUP_ORDER: StatusGroup[] = ['open', 'active', 'done', 'closed'];
const GROUP_LABEL: Record<StatusGroup, string> = {
  open: 'Open',
  active: 'Active',
  done: 'Done',
  closed: 'Closed',
};

interface BulkBarProps {
  ids: string[];
  /** How many rows the current filters match in total, for "select all". */
  matchTotal: number;
  allMatchingSelected: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
  fields: WoFieldDescriptor[];
  selectingAll?: boolean;
}

/**
 * The bar that appears the moment a row is ticked, sitting beside the status
 * tabs it acts on.
 *
 * "Set status" is its own control rather than one entry in the edit menu
 * because it is the change that actually happens all day — an operator moving
 * eleven work orders to `job scheduled` should not have to open a form to do it.
 */
export function BulkBar({
  ids,
  matchTotal,
  allMatchingSelected,
  onSelectAllMatching,
  onClear,
  fields,
  selectingAll,
}: BulkBarProps) {
  const qc = useQueryClient();
  const [result, setResult] = useState<BulkUpdateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['work-orders'] });
    qc.invalidateQueries({ queryKey: ['kpis'] });
    qc.invalidateQueries({ queryKey: ['wo-fields'] });
  };

  const apply = useMutation({
    mutationFn: (patch: Record<string, unknown>) => bulkUpdateWorkOrders(ids, patch),
    onSuccess: (res) => {
      setError(null);
      setResult(res);
      invalidate();
    },
    onError: (e: Error) => setError(e.message || 'The change could not be applied'),
  });

  const remove = useMutation({
    mutationFn: () => bulkDeleteWorkOrders(ids),
    onSuccess: (res) => {
      setError(null);
      setResult(res);
      invalidate();
      onClear();
    },
    onError: (e: Error) => setError(e.message || 'The work orders could not be deleted'),
  });

  const busy = apply.isPending || remove.isPending;

  return (
    <div className="bulkbar" role="region" aria-label="Bulk actions">
      <span className="bulk-count">
        <Icon name="check-circle" size={14} />
        {ids.length} selected
      </span>

      <BulkStatusMenu
        disabled={busy}
        onPick={(status_id) => apply.mutate({ status_id })}
      />

      <BulkEditMenu fields={fields} disabled={busy} onApply={(patch) => apply.mutate(patch)} />

      <button
        type="button"
        className="bulk-btn is-danger"
        disabled={busy}
        // Soft delete, and Admin → Trash restores it — but it still removes
        // rows from everyone's list, so it asks first.
        onClick={() => setConfirmDelete(true)}
      >
        <Icon name="trash" size={14} />
        Delete
      </button>

      {confirmDelete && (
        <ConfirmDialog
          title={`Move ${ids.length === 1 ? 'this work order' : `${ids.length.toLocaleString()} work orders`} to Trash?`}
          message={`${ids.length === 1 ? 'It disappears' : 'They disappear'} from everyone's list.`}
          note={
            <>
              An administrator can restore {ids.length === 1 ? 'it' : 'them'} from{' '}
              <b>Admin → Trash</b>.
            </>
          }
          noteTone="info"
          confirmLabel="Move to Trash"
          busyLabel="Moving…"
          danger
          busy={remove.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate(undefined, { onSettled: () => setConfirmDelete(false) })}
        />
      )}

      {/* The page holds up to 500 rows; the filters can match more. Acting on
          "everything that matches" has to be an explicit second step. */}
      {!allMatchingSelected && matchTotal > ids.length && (
        <button type="button" className="link-btn" onClick={onSelectAllMatching} disabled={selectingAll}>
          {selectingAll ? 'Selecting…' : `Select all ${matchTotal.toLocaleString()} matching`}
        </button>
      )}

      <button type="button" className="link-btn" onClick={onClear} disabled={busy}>
        Clear
      </button>

      {busy && <span className="bulk-note">Applying…</span>}
      {error && <span className="bulk-note is-err">{error}</span>}
      {result && !busy && !error && (
        <span className="bulk-note is-ok">
          {result.updated} updated
          {result.skipped.length > 0 && `, ${result.skipped.length} skipped`}
        </span>
      )}
    </div>
  );
}

function BulkStatusMenu({
  onPick,
  disabled,
}: {
  onPick: (statusId: string) => void;
  disabled?: boolean;
}) {
  const statuses = useQuery({
    queryKey: ['statuses'],
    queryFn: getStatuses,
    staleTime: 5 * 60 * 1000,
  });

  const grouped = useMemo(() => {
    const out: Record<StatusGroup, StatusWithPhase[]> = { open: [], active: [], done: [], closed: [] };
    for (const s of [...(statuses.data ?? [])].sort((a, b) => a.position - b.position)) {
      out[s.group].push(s);
    }
    return out;
  }, [statuses.data]);

  return (
    <Popover
      panelClassName="pop-bulk-status"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`bulk-btn${open ? ' is-open' : ''}`}
          onClick={toggle}
          disabled={disabled}
        >
          <Icon name="flag" size={14} />
          Set status
          <Icon name="chev-d" size={12} />
        </button>
      )}
    >
      {({ close }) => (
        <>
          {statuses.isLoading && <p className="pop-empty">Loading…</p>}
          {GROUP_ORDER.map((g) =>
            grouped[g].length ? (
              <div className="status-menu-group" key={g}>
                <div className="status-menu-group-label">{GROUP_LABEL[g]}</div>
                {grouped[g].map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className="status-menu-item"
                    style={pillStyle(s.color)}
                    onClick={() => {
                      onPick(s.id);
                      close();
                    }}
                  >
                    <span className="status-menu-dot" aria-hidden="true" />
                    <span className="status-menu-name">{s.name}</span>
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </>
      )}
    </Popover>
  );
}

/** Promoted columns a bulk edit can write, mirroring the API's own list. */
const EDITABLE_KEYS = [
  'client',
  'trade',
  'city',
  'state',
  'billing_entity',
  'priority',
  'nte',
  'date_received',
];

function BulkEditMenu({
  fields,
  onApply,
  disabled,
}: {
  fields: WoFieldDescriptor[];
  onApply: (patch: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  // Field key → the value to write. `null` means "clear this field".
  const [edits, setEdits] = useState<Record<string, string | null>>({});

  const editable = useMemo(
    () => fields.filter((f) => EDITABLE_KEYS.includes(f.key) || f.custom),
    [fields],
  );
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  const lists = useQuery({
    queryKey: ['routing-lists'],
    queryFn: listRoutingLists,
    staleTime: 5 * 60 * 1000,
  });

  const buildPatch = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    const custom: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(edits)) {
      if (key === 'home_list_id') {
        patch.home_list_id = value || null;
      } else if (key.startsWith('fields.')) {
        custom[key] = value === '' ? null : value;
      } else if (key === 'nte') {
        patch.nte = value === '' || value === null ? null : Number(value);
      } else {
        patch[key] = value === '' ? null : value;
      }
    }
    if (Object.keys(custom).length > 0) patch.fields = custom;
    return patch;
  };

  const count = Object.keys(edits).length;

  return (
    <Popover
      panelClassName="pop-bulk-edit"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`bulk-btn${open ? ' is-open' : ''}`}
          onClick={toggle}
          disabled={disabled}
        >
          <Icon name="pencil" size={14} />
          Edit
          <Icon name="chev-d" size={12} />
        </button>
      )}
    >
      {({ close }) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (count === 0) return;
            onApply(buildPatch());
            setEdits({});
            close();
          }}
        >
          <div className="pop-head">
            <span className="pop-title">Set fields on every selected work order</span>
          </div>

          {count === 0 && (
            <p className="pop-empty">
              Choose a field to set. Leaving a value blank clears that field.
            </p>
          )}

          <div className="edit-list">
            {Object.entries(edits).map(([key, value]) => {
              const f = byKey.get(key);
              const label = key === 'home_list_id' ? 'Home list' : (f?.label ?? key);
              return (
                <div className="edit-row" key={key}>
                  <span className="edit-label ellipsis">{label}</span>
                  {key === 'home_list_id' ? (
                    <select
                      className="rule-value"
                      value={value ?? ''}
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                    >
                      <option value="">Choose a list…</option>
                      {(lists.data?.items ?? []).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  ) : f?.options?.length ? (
                    <select
                      className="rule-value"
                      value={value ?? ''}
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                    >
                      <option value="">— clear —</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="rule-value"
                      type={
                        f?.type === 'date'
                          ? 'date'
                          : f?.type === 'number' || f?.type === 'money'
                            ? 'number'
                            : 'text'
                      }
                      value={value ?? ''}
                      placeholder="— clear —"
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    className="rule-x"
                    aria-label={`Do not change ${label}`}
                    onClick={() => {
                      const next = { ...edits };
                      delete next[key];
                      setEdits(next);
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="pop-foot">
            <FieldPicker
              fields={editable}
              label="Add a field"
              icon="plus"
              selected={Object.keys(edits)}
              onPick={(f) => setEdits((prev) => ({ ...prev, [f.key]: '' }))}
            />
            <button
              type="button"
              className="link-btn"
              onClick={() => setEdits((prev) => ({ ...prev, home_list_id: '' }))}
            >
              Move to a list
            </button>
          </div>

          <div className="pop-foot is-right">
            <button type="button" className="btn-sm is-ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn-sm" disabled={count === 0}>
              Apply to selection
            </button>
          </div>
        </form>
      )}
    </Popover>
  );
}
