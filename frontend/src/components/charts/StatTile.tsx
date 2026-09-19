/**
 * Stat tile — the form a single number takes.
 *
 * Contract: label (sentence case) · value · optional delta against a named
 * period · optional 12-point sparkline. The value uses proportional figures,
 * not tabular: at tile size `tabular-nums` makes a number like 121 look loose.
 */
import type { ReactNode } from 'react';
import { EMPTY } from '../../lib/format';
import { Sparkline } from './Sparkline';
import styles from './StatTile.module.css';

export interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  /** Signed change against a named baseline, e.g. "vs. previous 24 h". */
  delta?: {
    value: number;
    formatted: string;
    period: string;
    /** Whether an increase is a good outcome. Drives the colour. */
    higherIsBetter?: boolean | undefined;
  };
  trend?: (number | null)[];
  trendColor?: string;
  footnote?: ReactNode;
  icon?: ReactNode;
  isLoading?: boolean;
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  trend,
  trendColor,
  footnote,
  icon,
  isLoading = false,
}: StatTileProps): JSX.Element {
  const deltaTone = (() => {
    if (!delta || delta.value === 0) return 'flat';
    // With no stated direction the change is reported neutrally rather than
    // guessing whether up is good.
    if (delta.higherIsBetter === undefined) return 'neutral';
    const improving = delta.value > 0 === delta.higherIsBetter;
    return improving ? 'up' : 'down';
  })();

  return (
    <div className={styles.tile}>
      <div className={styles.head}>
        <p className={styles.label}>{label}</p>
        {icon && <span className={styles.icon}>{icon}</span>}
      </div>

      {isLoading ? (
        <div className={styles.loadingValue} aria-hidden="true" />
      ) : (
        <p className={styles.value}>
          {value}
          {unit && value !== EMPTY && <span className={styles.unit}>{unit}</span>}
        </p>
      )}

      <div className={styles.foot}>
        {delta && !isLoading && (
          <span className={[styles.delta, styles[deltaTone]].join(' ')}>
            <span aria-hidden="true">
              {delta.value > 0 ? '▲' : delta.value < 0 ? '▼' : '■'}
            </span>
            {delta.formatted}
            <span className={styles.period}>{delta.period}</span>
          </span>
        )}
        {footnote && !delta && <span className={styles.footnote}>{footnote}</span>}
        {trend && trend.length > 1 && (
          <span className={styles.trend}>
            <Sparkline values={trend} width={76} height={24} color={trendColor ?? 'var(--text-muted)'} />
          </span>
        )}
      </div>
    </div>
  );
}
