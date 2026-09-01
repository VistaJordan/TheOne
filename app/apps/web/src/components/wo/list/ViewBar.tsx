import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SavedView } from '../../../api/client';
import { Icon } from '../../Icon';
import { Popover } from './Popover';
import type { ViewState } from '../../../lib/woView';

interface ViewBarProps {
  views: SavedView[];
  activeId: string | null;
  /** True when the on-screen arrangement differs from the saved one. */
  dirty: boolean;
  /**
   * A saved view opens read-only: you can filter and sort it to look around
   * and nothing asks to be saved. `editing` is the mode entered with the
   * pencil, where those same changes track against the view and can be saved.
   */
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  state: ViewState;
  onSelect: (view: SavedView | null) => void;
  onSaveNew: (name: string, shared: boolean) => void;
  onSaveExisting: () => void;
  onDelete: (view: SavedView) => void;
  onResetToSaved: () => void;
  /**
   * Rows matching the active tab under the current status group, filters and
   * search. Shown as a badge on that tab only; null while loading.
   */
  count?: number | null;
  busy?: boolean;
  error?: string | null;
  /** Controls that move data in and out of the list (Import, Export). They
      sit beside "Save view" because all three act on the list as a whole,
      not on the rows in it. */
  actions?: ReactNode;
  /** The PERSONAL pinned view (user_pref): its tab leads the strip and the
      page opens on it. Null = nothing pinned. */
  pinnedId?: string | null;
  onTogglePin?: (view: SavedView) => void;
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="view-count" title={`${count.toLocaleString()} work order${count === 1 ? '' : 's'}`}>
      {count.toLocaleString()}
    </span>
  );
}

/**
 * The saved-view strip: one tab per view, plus the save control.
 *
 * A view is only "saved" when the person says so. Until then the tab carries a
 * dot and the toolbar shows what changed — so experimenting with filters never
 * silently rewrites the arrangement a colleague is relying on.
 */
export function ViewBar({
  views,
  activeId,
  dirty,
  editing,
  onEdit,
  onCancelEdit,
  state,
  onSelect,
  onSaveNew,
  onSaveExisting,
  onDelete,
  onResetToSaved,
  count,
  busy,
  error,
  actions,
  pinnedId = null,
  onTogglePin,
}: ViewBarProps) {
  const active = views.find((v) => v.id === activeId) ?? null;
  const badge = count != null ? <CountBadge count={count} /> : null;

  const viewTab = (v: SavedView) => (
    <button
      type="button"
      role="tab"
      key={v.id}
      aria-selected={v.id === activeId}
      className={`view-tab${v.id === activeId ? ' is-on' : ''}`}
      onClick={() => onSelect(v)}
      title={v.can_edit ? undefined : `Shared by ${v.owner.name}`}
    >
      {v.id === pinnedId && <Icon name="pushpin" size={12} />}
      {!v.can_edit && <Icon name="user" size={12} />}
      {v.name}
      {v.is_shared && v.can_edit && <Icon name="globe" size={12} />}
      {v.id === activeId && badge}
      {v.id === activeId && editing && dirty && (
        <span className="view-dot" title="Unsaved changes" />
      )}
    </button>
  );

  // The pinned tab leads the whole strip — ahead even of "All work orders" —
  // because it is where the page opens.
  const pinned = views.find((v) => v.id === pinnedId) ?? null;
  const rest = pinned ? views.filter((v) => v.id !== pinned.id) : views;

  return (
    <div className="viewbar">
      <div className="view-tabs" role="tablist" aria-label="Saved views">
        {pinned && viewTab(pinned)}
        <button
          type="button"
          role="tab"
          aria-selected={activeId === null}
          className={`view-tab${activeId === null ? ' is-on' : ''}`}
          onClick={() => onSelect(null)}
        >
          All work orders
          {activeId === null && badge}
        </button>

        {rest.map(viewTab)}
      </div>

      <div className="view-actions">
        {error && <span className="view-error">{error}</span>}

        {active && editing ? (
          <>
            <span className="view-mode">Editing</span>
            <button type="button" className="link-btn" onClick={onCancelEdit} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={onSaveExisting}
              disabled={busy || !dirty}
              title={dirty ? undefined : 'No changes yet'}
            >
              <Icon name="check" size={14} />
              Save “{active.name}”
            </button>
          </>
        ) : (
          dirty && (
            // Just looking: the tweaks are yours for now and go nowhere. This
            // is the way back to the view as saved (or to the plain list).
            <button
              type="button"
              className="link-btn"
              onClick={onResetToSaved}
              disabled={busy}
              title={active ? `Back to “${active.name}” as saved` : 'Back to the default list'}
            >
              <Icon name="refresh" size={12} />
              Reset
            </button>
          )
        )}

        {actions}

        <SaveAsMenu
          suggestion={active ? `${active.name} copy` : ''}
          state={state}
          onSave={onSaveNew}
          busy={busy}
        />

        {/* Pinning is personal (user_pref), so a shared colleague's view can
            be pinned too — it changes where YOUR page opens, not their view. */}
        {active && onTogglePin && (
          <button
            type="button"
            className={`icon-btn${active.id === pinnedId ? ' is-pinned' : ''}`}
            title={
              active.id === pinnedId
                ? `Unpin “${active.name}” — open on the plain list again`
                : `Pin “${active.name}” — Work Orders opens on this view`
            }
            onClick={() => onTogglePin(active)}
            disabled={busy}
          >
            <Icon name="pushpin" size={14} />
          </button>
        )}

        {active?.can_edit && !editing && (
          <button
            type="button"
            className="icon-btn"
            title={`Edit “${active.name}”`}
            onClick={onEdit}
            disabled={busy}
          >
            <Icon name="pencil" size={14} />
          </button>
        )}

        {active?.can_edit && (
          <button
            type="button"
            className="icon-btn"
            title={`Delete “${active.name}”`}
            onClick={() => onDelete(active)}
            disabled={busy}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function SaveAsMenu({
  suggestion,
  state,
  onSave,
  busy,
}: {
  suggestion: string;
  state: ViewState;
  onSave: (name: string, shared: boolean) => void;
  busy?: boolean;
}) {
  const [name, setName] = useState(suggestion);
  const [shared, setShared] = useState(false);
  const ruleCount = state.filters.rules.length;

  return (
    <Popover
      align="right"
      panelClassName="pop-saveview"
      trigger={({ open, toggle }) => (
        <button type="button" className={`btn-sm is-ghost${open ? ' is-open' : ''}`} onClick={toggle}>
          <Icon name="plus" size={14} />
          Save view
        </button>
      )}
    >
      {({ close }) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            onSave(trimmed, shared);
            close();
          }}
        >
          <div className="pop-head">
            <span className="pop-title">Save this view</span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={name}
              autoFocus
              maxLength={80}
              placeholder="e.g. Chicago HVAC — awaiting approval"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>
              Share with the team
              <small>Everyone can use it; only you can change it.</small>
            </span>
          </label>
          <p className="pop-note">
            Saves {state.columns.length} column{state.columns.length === 1 ? '' : 's'}
            {ruleCount > 0 && `, ${ruleCount} filter${ruleCount === 1 ? '' : 's'}`}
            {state.group_by && ', the grouping'}
            {state.sort && ', the sort order'}.
          </p>
          <div className="pop-foot is-right">
            <button type="button" className="btn-sm is-ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn-sm" disabled={busy || !name.trim()}>
              Save
            </button>
          </div>
        </form>
      )}
    </Popover>
  );
}
