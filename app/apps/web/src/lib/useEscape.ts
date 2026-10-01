import { useEffect } from 'react';

/** Close on Escape wherever the focus is — a dialog whose only handler sits on
    its own element misses the key until something inside it is focused. */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
}
