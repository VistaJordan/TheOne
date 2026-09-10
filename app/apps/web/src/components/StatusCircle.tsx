/**
 * The ClickUp-style status circle, drawn per phase group:
 *   open           a dashed ring — nothing has happened yet
 *   done / closed  a filled disc with a check — finished
 *   anything else  a solid ring with a pie wedge whose fill grows with the
 *                  status's position inside its group (`fraction`)
 *
 * Colors come straight from `status.color` (the DB hex), identical in both
 * themes — the circle is a swatch of the status, not themed ink.
 */
export function StatusCircle({
  group,
  color,
  fraction = 0.5,
  size = 16,
  className,
}: {
  group: string;
  color: string;
  /** 0..1 — how far through its group this status sits. Active groups only. */
  fraction?: number;
  size?: number;
  className?: string;
}) {
  const cls = className ? `status-circle ${className}` : 'status-circle';

  if (group === 'done' || group === 'closed') {
    return (
      <svg viewBox="0 0 20 20" width={size} height={size} className={cls} aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill={color} />
        <path
          d="M6.1 10.4l2.5 2.5 5.3-5.4"
          fill="none"
          stroke="#fff"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (group === 'open') {
    return (
      <svg viewBox="0 0 20 20" width={size} height={size} className={cls} aria-hidden="true">
        {/* 2π·8 ≈ 50.27 ⇒ dash+gap of 5.027 tiles the ring in exactly 10 dashes */}
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeDasharray="2.9 2.127"
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
        />
      </svg>
    );
  }

  // A stroke of width 6.5 on a r=3.25 circle fills the disc out to r=6.5 —
  // the standard SVG pie trick; the dash length is the wedge.
  const frac = Math.min(1, Math.max(0.12, fraction));
  const r = 3.25;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} className={cls} aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke={color} strokeWidth="2" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="6.5"
        strokeDasharray={`${(c * frac).toFixed(3)} ${c.toFixed(3)}`}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}
