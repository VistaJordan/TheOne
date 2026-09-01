import { useTheme } from './ThemeProvider';

/** Sun/moon button in the topbar; flips night/day, persists. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isNight = theme === 'night';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={isNight ? 'Switch to Daylight theme' : 'Switch to Blackout theme'}
      title={isNight ? 'Daylight Dispatch' : 'Blackout'}
    >
      {isNight ? (
        /* moon → currently night, click for day (sun) */
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="12" y1="2.5" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="21.5" />
            <line x1="2.5" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="21.5" y2="12" />
            <line x1="5.3" y1="5.3" x2="7" y2="7" />
            <line x1="17" y1="17" x2="18.7" y2="18.7" />
            <line x1="5.3" y1="18.7" x2="7" y2="17" />
            <line x1="17" y1="7" x2="18.7" y2="5.3" />
          </g>
        </svg>
      ) : (
        /* sun → currently day, click for night (moon) */
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
