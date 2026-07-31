import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface CopyButtonProps {
  value: string;
  label: string;
  size?: 12 | 14;
}

/** The comp's .copybtn — copies `value`, flashes a check for 1.2s. */
export function CopyButton({ value, label, size = 14 }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = () => {
    // Older/insecure contexts have no navigator.clipboard — fail silently and
    // leave the icon untouched rather than lying with a check mark.
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
      className={`copybtn${copied ? ' is-copied' : ''}`}
      aria-label={copied ? `${label} copied` : label}
      title={label}
      onClick={copy}
    >
      <Icon name={copied ? 'check' : 'copy'} size={size} />
    </button>
  );
}
