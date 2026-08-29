import { useState } from 'react';
import type { SavedView } from '../../../api/client';
import { Icon } from '../../Icon';
import { Popover } from './Popover';
import type { ViewState } from '../../../lib/woView';

interface ViewBarProps {
  views: SavedView[];
  activeId: string | null;
  /** True when the on-screen arrangement differs from the saved one. */
  dirty: boolean;
  state: ViewState;
  onSelect: (view: SavedView | null) => void;
  onSaveNew: (name: string, shared: boolean) => void;
  onSaveExisting: () => void;
  onDelete: (view: SavedView) => void;
  onResetToSaved: () => void;
  busy?: boolean;
  error?: string | null;
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
  state,
  onSelect,
  onSaveNew,
  onSaveExisting,
  onDelete,
  onResetToSaved,
  busy,
  error,
}: ViewBarProps) {
  const active = views.find((v) => v.id === activeId) ?? null;

  return (
    <div className="viewbar">
      <div className="view-tabs" role="tablist" aria-label="Saved views">
        <button
          type="button"
          role="tab"
          aria-selected={activeId === null}
          className={`view-tab${activeId === null ? ' is-on' : ''}`}
          onClick={() => onSelect(null)}
        >
          All work orders
          {activeId === null && dirty && <span className="view-dot" title="Unsaved changes" />}
        </button>

        {views.map((v) => (
          <button
            type="button"
            role="tab"
            key={v.id}
            aria-selected={v.id === activeId}
            className={`view-tab${v.id === activeId ? ' is-on' : ''}`}
            onClick={() => onSelect(v)}
            title={v.can_edit ? undefined : `Shared by ${v.owner.name}`}
          >
            {!v.can_edit && <Icon name="user" size={12} />}
            {v.name}
            {v.is_shared && v.can_edit && <Icon name="globe" size={12} />}
            {v.id === activeId && dirty && <span className="view-dot" title="Unsaved changes" />}
          </button>
        ))}
      </div>

      <div className="view-actions">
        {error && <span className="view-error">{error}</span>}

        {dirty && active && (
          <button type="button" className="link-btn" onClick={onResetToSaved} disabled={busy}>
            Discard changes
          </button>
        )}

        {dirty && active?.can_edit && (
          <button type="button" className="btn-sm" onClick={onSaveExisting} disabled={busy}>
            <Icon name="check" size={14} />
            Save “{active.name}”
          </button>
        )}

        <SaveAsMenu
          suggestion={active ? `${active.name} copy` : ''}
          state={state}
          onSave={onSaveNew}
          busy={busy}
        />

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
