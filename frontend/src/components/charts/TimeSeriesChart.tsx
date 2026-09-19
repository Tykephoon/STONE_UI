/**
 * Multi-series time-series chart.
 *
 * Built to fixed mark specs: 2px lines with round joins, area fills at 10%
 * opacity, gap-aware paths, hairline grid, an 8px hover marker ringed in the
 * surface colour, and a crosshair tooltip.
 *
 * Single-axis only. Two measures on different scales get two charts — a second
 * y-axis makes the crossing point of two lines look meaningful when it is an
 * artefact of the scaling.
 */
import { useCallback, useMemo, useState } from 'react';
import { formatDateTimeShort, formatTime } from '../../lib/time';
import styles from './TimeSeriesChart.module.css';
import {
  areaPath,
  extent,
  formatTick,
  linePath,
  linearScale,
  niceDomain,
  sampleIndices,
  seriesColor,
} from './scales';
import { useChartSize } from './useChartSize';

export interface ChartSeries {
  key: string;
  label: string;
  /** One entry per point, aligned with `timestamps`. Null means "no reading". */
  values: (number | null)[];
  unit?: string;
  digits?: number;
}

export interface TimeSeriesChartProps {
  timestamps: number[];
  series: ChartSeries[];
  height?: number;
  /** Fills under the line. Only sensible for a single series. */
  showArea?: boolean;
  /** Forces the y-domain to include zero. */
  includeZero?: boolean;
  emptyMessage?: string;
  /** Accessible description of what the chart shows. */
  ariaLabel: string;
}

const MARGIN = { top: 12, right: 16, bottom: 26, left: 52 };

export function TimeSeriesChart({
  timestamps,
  series,
  height = 240,
  showArea = false,
  includeZero = false,
  emptyMessage = 'No data in this range.',
  ariaLabel,
}: TimeSeriesChartProps): JSX.Element {
  const [containerRef, width] = useChartSize<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const plotWidth = Math.max(80, width - MARGIN.left - MARGIN.right);
  const plotHeight = Math.max(60, height - MARGIN.top - MARGIN.bottom);

  const hasData =
    timestamps.length > 0 &&
    series.some((entry) => entry.values.some((value) => typeof value === 'number'));

  const { xScale, yScale, ticks, tickStep } = useMemo(() => {
    const xDomain: [number, number] =
      timestamps.length > 1
        ? [timestamps[0]!, timestamps[timestamps.length - 1]!]
        : [(timestamps[0] ?? 0) - 1, (timestamps[0] ?? 0) + 1];

    const allValues = series.flatMap((entry) => entry.values);
    const valueExtent = extent(allValues) ?? [0, 1];

    let [minValue, maxValue] = valueExtent;
    if (includeZero) {
      minValue = Math.min(0, minValue);
      maxValue = Math.max(0, maxValue);
    }

    const { domain, ticks: yTicks } = niceDomain(minValue, maxValue, 4);
    const step = yTicks.length > 1 ? Math.abs(yTicks[1]! - yTicks[0]!) : 1;

    return {
      xScale: linearScale(xDomain, [0, plotWidth]),
      yScale: linearScale(domain, [plotHeight, 0]),
      ticks: yTicks,
      tickStep: step,
    };
  }, [timestamps, series, plotWidth, plotHeight, includeZero]);

  const points = useMemo(
    () =>
      series.map((entry) => ({
        ...entry,
        points: timestamps.map((time, index) => ({
          x: time,
          y: entry.values[index] ?? null,
        })),
      })),
    [series, timestamps],
  );

  /** Snap the crosshair to the nearest sample rather than following the cursor. */
  const handleMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (timestamps.length === 0) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left - MARGIN.left;
      const time = xScale.invert(Math.max(0, Math.min(plotWidth, x)));

      let nearest = 0;
      let smallest = Number.POSITIVE_INFINITY;
      for (let index = 0; index < timestamps.length; index += 1) {
        const distance = Math.abs(timestamps[index]! - time);
        if (distance < smallest) {
          smallest = distance;
          nearest = index;
        }
      }
      setHoverIndex(nearest);
    },
    [timestamps, xScale, plotWidth],
  );

  const xTickIndices = useMemo(
    () => sampleIndices(timestamps.length, Math.max(2, Math.floor(plotWidth / 110))),
    [timestamps.length, plotWidth],
  );

  const spansMultipleDays = useMemo(() => {
    if (timestamps.length < 2) return false;
    return timestamps[timestamps.length - 1]! - timestamps[0]! > 86_400_000;
  }, [timestamps]);

  if (!hasData) {
    return (
      <div className={styles.container} ref={containerRef}>
        <div className={styles.empty} style={{ height }}>
          <p>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  const hoverTime = hoverIndex !== null ? timestamps[hoverIndex] : undefined;
  const hoverX = hoverTime !== undefined ? xScale(hoverTime) : 0;
  // Flip the tooltip to the left of the crosshair when it would overflow.
  const tooltipFlips = hoverX > plotWidth - 150;

  return (
    <div className={styles.container} ref={containerRef}>
      <svg
        className={styles.svg}
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Horizontal grid — hairline, solid, recessive. */}
          {ticks.map((tick) => (
            <line
              key={tick}
              x1={0}
              x2={plotWidth}
              y1={yScale(tick)}
              y2={yScale(tick)}
              className={styles.grid}
            />
          ))}

          {/* Y-axis labels */}
          {ticks.map((tick) => (
            <text
              key={`label-${tick}`}
              x={-10}
              y={yScale(tick)}
              className={styles.axisLabel}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {formatTick(tick, tickStep)}
            </text>
          ))}

          {/* X-axis labels */}
          {xTickIndices.map((index) => {
            const time = timestamps[index];
            if (time === undefined) return null;
            return (
              <text
                key={`x-${index}`}
                x={xScale(time)}
                y={plotHeight + 18}
                className={styles.axisLabel}
                textAnchor={index === 0 ? 'start' : index === timestamps.length - 1 ? 'end' : 'middle'}
              >
                {spansMultipleDays ? formatDateTimeShort(new Date(time).toISOString()) : formatTime(new Date(time).toISOString())}
              </text>
            );
          })}

          {/* Area fills sit under every line so no fill covers a neighbour's stroke. */}
          {showArea &&
            points.map((entry, index) => (
              <path
                key={`area-${entry.key}`}
                d={areaPath(entry.points, xScale, yScale, yScale.domain[0])}
                fill={seriesColor(index)}
                fillOpacity={0.1}
                stroke="none"
              />
            ))}

          {points.map((entry, index) => (
            <path
              key={`line-${entry.key}`}
              d={linePath(entry.points, xScale, yScale)}
              className={styles.line}
              stroke={seriesColor(index)}
            />
          ))}

          {/* Crosshair and hover markers */}
          {hoverIndex !== null && (
            <>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={0}
                y2={plotHeight}
                className={styles.crosshair}
              />
              {points.map((entry, index) => {
                const value = entry.points[hoverIndex]?.y;
                if (value === null || value === undefined) return null;
                return (
                  <circle
                    key={`marker-${entry.key}`}
                    cx={hoverX}
                    cy={yScale(value)}
                    r={4}
                    fill={seriesColor(index)}
                    className={styles.marker}
                  />
                );
              })}
            </>
          )}
        </g>
      </svg>

      {hoverIndex !== null && hoverTime !== undefined && (
        <div
          className={styles.tooltip}
          style={{
            left: MARGIN.left + hoverX + (tooltipFlips ? -12 : 12),
            top: MARGIN.top,
            transform: tooltipFlips ? 'translateX(-100%)' : undefined,
          }}
          role="status"
        >
          <p className={styles.tooltipTime}>
            {formatDateTimeShort(new Date(hoverTime).toISOString())}
          </p>
          <ul className={styles.tooltipList}>
            {points.map((entry, index) => {
              const value = entry.points[hoverIndex]?.y;
              return (
                <li key={entry.key} className={styles.tooltipRow}>
                  <span
                    className={styles.swatch}
                    style={{ background: seriesColor(index) }}
                    aria-hidden="true"
                  />
                  <span className={styles.tooltipLabel}>{entry.label}</span>
                  <span className={styles.tooltipValue}>
                    {typeof value === 'number'
                      ? `${value.toFixed(entry.digits ?? 1)}${entry.unit ? ` ${entry.unit}` : ''}`
                      : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/*
        A legend whenever there is more than one series: identity must never
        depend on matching colours by eye. One series needs none — the card
        title already says what is plotted.
      */}
      {series.length > 1 && (
        <ul className={styles.legend}>
          {series.map((entry, index) => (
            <li key={entry.key} className={styles.legendItem}>
              <span
                className={styles.legendKey}
                style={{ background: seriesColor(index) }}
                aria-hidden="true"
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
