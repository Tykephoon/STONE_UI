/**
 * Twelve-point trend line for stat tiles.
 *
 * No axes, no labels, no tooltip: it shows shape, not values. The tile's own
 * number carries the magnitude, and the full chart is one click away.
 */
import { extent, linePath, linearScale } from './scales';
import styles from './Sparkline.module.css';

export interface SparklineProps {
  values: (number | null)[];
  width?: number;
  height?: number;
  /** Series colour. Defaults to the muted trend treatment. */
  color?: string;
  /** Emphasises the final point with a filled dot. */
  showEndDot?: boolean;
}

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = 'var(--text-muted)',
  showEndDot = true,
}: SparklineProps): JSX.Element | null {
  const numeric = values.filter((value): value is number => typeof value === 'number');
  if (numeric.length < 2) return null;

  const bounds = extent(values);
  if (!bounds) return null;

  const padding = 3;
  const xScale = linearScale([0, values.length - 1], [padding, width - padding]);
  // A flat series would collapse onto the top edge; niceDomain is overkill here,
  // so pad the range directly.
  const [low, high] = bounds;
  const span = high - low || Math.abs(high) * 0.1 || 1;
  const yScale = linearScale([low - span * 0.12, high + span * 0.12], [height - padding, padding]);

  const points = values.map((value, index) => ({ x: index, y: value }));
  const path = linePath(points, xScale, yScale);

  const lastIndex = values.length - 1;
  const lastValue = values[lastIndex];

  return (
    <svg
      className={styles.sparkline}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {showEndDot && typeof lastValue === 'number' && (
        <circle
          cx={xScale(lastIndex)}
          cy={yScale(lastValue)}
          r={2.2}
          fill={color}
          className={styles.endDot}
        />
      )}
    </svg>
  );
}
