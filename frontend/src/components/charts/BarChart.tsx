/**
 * Categorical bar chart, drawn horizontally.
 *
 * Horizontal because the categories here are device names and metric labels —
 * text that reads naturally along a row and would need rotating on a column
 * chart.
 */
import { useMemo, useState } from 'react';
import { formatTick, linearScale, niceDomain } from './scales';
import { useChartSize } from './useChartSize';
import styles from './BarChart.module.css';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Optional per-bar colour. Defaults to the single-series accent. */
  color?: string;
}

export interface BarChartProps {
  data: BarDatum[];
  unit?: string;
  digits?: number;
  ariaLabel: string;
  emptyMessage?: string;
}

const LABEL_WIDTH = 116;
const BAR_HEIGHT = 20;
const BAR_GAP = 12;
const RIGHT_PAD = 56;

export function BarChart({
  data,
  unit,
  digits = 0,
  ariaLabel,
  emptyMessage = 'Nothing to show yet.',
}: BarChartProps): JSX.Element {
  const [containerRef, width] = useChartSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);

  const plotWidth = Math.max(60, width - LABEL_WIDTH - RIGHT_PAD);
  const height = data.length * (BAR_HEIGHT + BAR_GAP);

  const { scale, ticks, step } = useMemo(() => {
    const max = Math.max(0, ...data.map((entry) => entry.value));
    const { domain, ticks: computed } = niceDomain(0, max, 4);
    return {
      scale: linearScale(domain, [0, plotWidth]),
      ticks: computed,
      step: computed.length > 1 ? Math.abs(computed[1]! - computed[0]!) : 1,
    };
  }, [data, plotWidth]);

  if (data.length === 0) {
    return (
      <div className={styles.container} ref={containerRef}>
        <p className={styles.empty}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <svg width={width} height={height + 22} role="img" aria-label={ariaLabel} className={styles.svg}>
        <g transform={`translate(${LABEL_WIDTH},0)`}>
          {ticks.map((tick) => (
            <line
              key={tick}
              x1={scale(tick)}
              x2={scale(tick)}
              y1={0}
              y2={height}
              className={styles.grid}
            />
          ))}
          {ticks.map((tick) => (
            <text
              key={`t-${tick}`}
              x={scale(tick)}
              y={height + 15}
              className={styles.axisLabel}
              textAnchor="middle"
            >
              {formatTick(tick, step)}
            </text>
          ))}
        </g>

        {data.map((entry, index) => {
          const y = index * (BAR_HEIGHT + BAR_GAP);
          const barWidth = Math.max(0, scale(entry.value));
          const isHovered = hovered === entry.key;

          return (
            <g
              key={entry.key}
              onMouseEnter={() => setHovered(entry.key)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* A full-width transparent row makes the hover target the whole
                  line rather than just the drawn bar. */}
              <rect x={0} y={y - BAR_GAP / 2} width={width} height={BAR_HEIGHT + BAR_GAP} fill="transparent" />
              <text
                x={LABEL_WIDTH - 12}
                y={y + BAR_HEIGHT / 2}
                className={styles.category}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {entry.label}
              </text>
              <rect
                x={LABEL_WIDTH}
                y={y}
                width={barWidth}
                height={BAR_HEIGHT}
                rx={4}
                fill={entry.color ?? 'var(--series-1)'}
                opacity={hovered && !isHovered ? 0.55 : 1}
                className={styles.bar}
              />
              <text
                x={LABEL_WIDTH + barWidth + 8}
                y={y + BAR_HEIGHT / 2}
                className={styles.value}
                dominantBaseline="middle"
              >
                {entry.value.toFixed(digits)}
                {unit ? ` ${unit}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
