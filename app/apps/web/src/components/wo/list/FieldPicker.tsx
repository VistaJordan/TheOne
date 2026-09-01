import { useMemo, useState } from 'react';
import type { WoFieldDescriptor } from '../../../api/client';
import { Icon } from '../../Icon';
import type { IconName } from '../../Icon';
import { Popover } from './Popover';

interface FieldPickerProps {
  fields: WoFieldDescriptor[];
  label: string;
  onPick: (field: WoFieldDescriptor) => void;
  /** 'button' reads as an action ("Add filter"); 'select' as a chosen value. */
  variant?: 'button' | 'select';
  icon?: IconName;
  /** Keys already used, shown ticked. */
  selected?: string[];
}

/**
 * "Which field?" — searchable, grouped by section.
 *
 * The catalogue is around 120 fields once the custom ones are counted, so this
 * is a search box first and a list second: scanning that many entries by eye is
 * slower than typing three letters of the one you want.
 */
export function FieldPicker({
  fields,
  label,
  onPick,
  variant = 'button',
  icon,
  selected = [],
}: FieldPickerProps) {
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? fields.filter(
          (f) => f.label.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle),
        )
      : fields;
    const out = new Map<string, WoFieldDescriptor[]>();
    for (const f of matched) {
      const list = out.get(f.group);
      if (list) list.push(f);
      else out.set(f.group, [f]);
    }
    return [...out.entries()];
  }, [fields, q]);

  return (
    <Popover
      panelClassName="pop-fields"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={
            variant === 'select'
              ? `rule-field${open ? ' is-open' : ''}`
              : `link-btn${open ? ' is-open' : ''}`
          }
          onClick={toggle}
          aria-expanded={open}
        >
          {icon && <Icon name={icon} size={12} />}
          <span className="ellipsis">{label}</span>
          {variant === 'select' && <Icon name="chev-d" size={12} />}
        </button>
      )}
    >
      {({ close }) => (
        <>
          <input
            className="pop-search"
            type="search"
            placeholder="Search fields…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="field-list">
            {groups.length === 0 && <p className="pop-empty">No field matches “{q}”.</p>}
            {groups.map(([group, list]) => (
              <div className="field-group" key={group}>
                <div className="field-group-label">{group}</div>
                {list.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    className={`field-item${selected.includes(f.key) ? ' is-on' : ''}`}
                    onClick={() => {
                      onPick(f);
                      close();
                    }}
                  >
                    <span className="ellipsis">{f.label}</span>
                    <span className="field-type">{f.type}</span>
                    {selected.includes(f.key) && <Icon name="check" size={12} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}
