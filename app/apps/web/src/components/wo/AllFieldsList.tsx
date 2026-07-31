import type { Fields } from '../../lib/fields';
import { fieldValueToString } from '../../lib/fields';
import { Icon } from '../Icon';

interface AllFieldsListProps {
  fields: Fields;
}

const isUrl = (v: string) => /^https?:\/\//i.test(v);

/** "All fields" tab — a plain two-column dump of the task.fields JSONB,
    key-sorted so the numbered intake fields (1. → 38.) group naturally. */
export function AllFieldsList({ fields }: AllFieldsListProps) {
  const entries = Object.entries(fields ?? {}).sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }),
  );

  if (entries.length === 0) {
    return (
      <div className="tab-empty">
        <Icon name="clipboard" size={22} />
        <b>No custom fields</b>
        <span>This work order carries an empty field bag.</span>
      </div>
    );
  }

  return (
    <dl className="fieldlist">
      {entries.map(([key, value]) => {
        const text = fieldValueToString(value);
        return (
          <div className="fieldrow" key={key}>
            <dt>{key}</dt>
            <dd className={typeof value === 'boolean' && value ? 'is-bool' : undefined}>
              {isUrl(text) ? (
                <a href={text} target="_blank" rel="noreferrer noopener">{text}</a>
              ) : (
                text
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
