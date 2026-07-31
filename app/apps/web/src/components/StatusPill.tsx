import type { CSSProperties, ReactNode } from 'react';
import type { StatusRef } from '@theone/shared';

/** Static 3-entry override map (keyed by lower-cased hex) for the three
    day-theme colors whose base formula falls below 4.5:1 (SPRINT1-SPEC §6). */
const DAY_INK_OVERRIDE: Record<string, string> = {
  '#f8ae00': '#7c5700', // assessment ongoing / job ongoing → 5.96:1
  '#6bed5e': '#36772f', // !! ready to invoice              → 5.11:1
  '#64c6a2': '#326351', // done/incurred                    → 6.27:1
};

interface PillVars extends CSSProperties {
  '--pill': string;
  '--pill-ink-day'?: string;
}

export function pillStyle(color: string): PillVars {
  const hex = color.toLowerCase();
  const style: PillVars = { '--pill': color };
  const override = DAY_INK_OVERRIDE[hex];
  if (override) style['--pill-ink-day'] = override;
  return style;
}

interface StatusPillProps {
  status: Pick<StatusRef, 'name' | 'color'>;
  onClick?: () => void;
  /** Node before the label — the detail header passes the comp's .pill-dot. */
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}

/** Renders a status by its real hex color via color-mix tints (styles/app.css). */
export function StatusPill({ status, onClick, leading, trailing, className }: StatusPillProps) {
  const cls = ['pill', onClick ? 'pill-button' : '', className].filter(Boolean).join(' ');
  const content = (
    <>
      {leading}
      <span className="pill-label">{status.name}</span>
      {trailing}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} style={pillStyle(status.color)} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span className={cls} style={pillStyle(status.color)}>
      {content}
    </span>
  );
}
