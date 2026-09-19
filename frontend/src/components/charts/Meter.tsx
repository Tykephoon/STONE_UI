import styles from './Meter.module.css';

export type MeterTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

export interface MeterProps {
  /** Current value, clamped into [min, max] for display. */
  value: number;
  min: number;
  max: number;
  tone?: MeterTone;
  label: string;
  display: string;
  /** Optional reference marker, e.g. the target inflation pressure. */
  target?: number;
}

/**
 * A horizontal meter.
 *
 * The fill carries severity; the track is a dimmer step of the same family so
 * state reads across the whole bar rather than only the filled part.
 */
export function Meter({
  value,
  min,
  max,
  tone = 'neutral',
  label,
  display,
  target,
}: MeterProps): JSX.Element {
  const span = max - min || 1;
  const clamped = Math.max(min, Math.min(max, value));
  const percent = ((clamped - min) / span) * 100;
  const targetPercent =
    target === undefined ? null : ((Math.max(min, Math.min(max, target)) - min) / span) * 100;

  return (
    <div className={styles.meter}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{display}</span>
      </div>
      <div
        className={[styles.track, styles[tone]].join(' ')}
        role="meter"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={label}
        aria-valuetext={display}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
        {targetPercent !== null && (
          <span
            className={styles.target}
            style={{ left: `${targetPercent}%` }}
            aria-hidden="true"
            title="Target"
          />
        )}
      </div>
    </div>
  );
}
