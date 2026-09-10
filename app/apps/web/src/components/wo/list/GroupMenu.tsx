import { useMemo, useState } from 'react';
import type { WoFieldDescriptor } from '../../../api/client';
import { Icon } from '../../Icon';
import { Popover, ToolButton } from './Popover';

interface GroupMenuProps {
  fields: WoFieldDescriptor[];
  value: string | null;
  onChange: (next: string | null) => void;
}

/**
 * Bucket the list by a field — by trade, by client, by status, by whatever.
 *
 * Any field can be a grouping key, but the useful ones are the low-cardinality
 * ones, so `select` fields sort to the top: grouping by Title would produce one
 * bucket per work order, which is the flat list with extra headers.
 */
export function GroupMenu({ fields, value, onChange }: GroupMenuProps) {
  const [q, setQ] = useState('');
  const current = fields.find((f) => f.key === value);

  const ordered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? fields.filter(
          (f) => f.label.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle),
        )
      : fields;
    const rank = (f: WoFieldDescriptor) => (f.type === 'select' || f.type === 'boolean' ? 0 : 1);
    return [...matched].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }, [fields, q]);

  return (
    <Popover
      panelClassName="pop-group"
      trigger={({ open, toggle }) => (
        <ToolButton active={value !== null} pressed={open} onClick={toggle}>
          <Icon name="layers" size={14} />
          {current ? `Grouped by ${current.label}` : 'Group'}
        </ToolButton>
      )}
    >
      {({ close }) => (
        <>
          <input
            className="pop-search"
            type="search"
            placeholder="Group by…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="field-list">
            <button
              type="button"
              className={`field-item${value === null ? ' is-on' : ''}`}
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              <span>No grouping</span>
              {value === null && <Icon name="check" size={12} />}
            </button>
            {ordered.slice(0, 200).map((f) => (
              <button
                type="button"
                key={f.key}
                className={`field-item${value === f.key ? ' is-on' : ''}`}
                onClick={() => {
                  onChange(f.key);
                  close();
                }}
              >
                <span className="ellipsis">{f.label}</span>
                <span className="field-type">{f.group}</span>
                {value === f.key && <Icon name="check" size={12} />}
              </button>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}
