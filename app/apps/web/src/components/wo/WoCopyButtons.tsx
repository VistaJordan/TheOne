import { useEffect, useRef, useState } from 'react';
import { woCopyFull, woCopyVague } from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../api/client';
import { Icon } from '../Icon';

/** One labelled copy button: copies `value`, reads "Copied" for 1.2s. */
function CopyTextButton({ value, label, title }: { value: string; label: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <button
      type="button"
      className={`btn wohead-copy${copied ? ' is-copied' : ''}`}
      onClick={copy}
      disabled={value === ''}
      title={value === '' ? 'Nothing to copy yet' : `${title}\n\n${value}`}
      aria-label={copied ? `${label} copied` : label}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Elise, 2026-11-12 · the two copy buttons at the right of the header.
 *  Copy full: WO #, address, store, scope. Copy vague: street + city + ZIP and
 *  the scope — for a technician not hired yet. Text built in shared woCopy.ts. */
export function WoCopyButtons({ wo }: { wo: WorkOrderDetailV2 }) {
  const src = { wo_number: wo.wo_number, description: wo.description, city: wo.city, fields: wo.fields ?? {} };
  return (
    <span className="wohead-copies">
      <CopyTextButton value={woCopyFull(src)} label="Copy full" title="Copies WO #, address, store and scope" />
      <CopyTextButton value={woCopyVague(src)} label="Copy vague" title="Copies street, city, ZIP and scope" />
    </span>
  );
}
