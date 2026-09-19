/**
 * Per-wheel pressure and temperature, laid out as the vehicle sits.
 *
 * The spatial layout is the point: "rear-left is low" is obvious from a grid
 * and invisible in a list of four labelled numbers.
 */
import { Meter, type MeterTone } from '../../components/charts/Meter';
import type { Reading, TirePosition } from '../../data/types';
import { EMPTY, formatNumber, isPresent, kpaToPsi } from '../../lib/format';
import styles from './TireGrid.module.css';

export interface TireGridProps {
  reading: Reading | null;
  /**
   * Target cold inflation pressure in kPa, used for the deviation band. With
   * no target configured the meters show value only and no severity.
   */
  targetKpa?: number | null;
  showPsi?: boolean;
}

const LAYOUT: { position: TirePosition; label: string; short: string }[] = [
  { position: 'front_left', label: 'Front left', short: 'FL' },
  { position: 'front_right', label: 'Front right', short: 'FR' },
  { position: 'rear_left', label: 'Rear left', short: 'RL' },
  { position: 'rear_right', label: 'Rear right', short: 'RR' },
];

/**
 * Severity from deviation against the target.
 *
 * Thresholds follow the usual under-inflation guidance: within 5% is normal,
 * 10% is worth watching, 20% is the point at which handling and tyre life are
 * genuinely affected.
 */
function toneFor(pressure: number | null, target: number | null | undefined): MeterTone {
  if (!isPresent(pressure) || !isPresent(target ?? null)) return 'neutral';
  const deviation = Math.abs(pressure - target!) / target!;
  if (deviation <= 0.05) return 'good';
  if (deviation <= 0.1) return 'warning';
  if (deviation <= 0.2) return 'serious';
  return 'critical';
}

const TONE_LABEL: Record<MeterTone, string> = {
  good: 'Normal',
  warning: 'Slightly off',
  serious: 'Check',
  critical: 'Action needed',
  neutral: 'No target set',
};

export function TireGrid({ reading, targetKpa = null, showPsi = false }: TireGridProps): JSX.Element {
  const min = targetKpa ? targetKpa * 0.6 : 0;
  const max = targetKpa ? targetKpa * 1.3 : 400;

  return (
    <div className={styles.grid}>
      {LAYOUT.map(({ position, label, short }) => {
        const tire = reading?.tires?.[position];
        const pressure = tire?.pressure_kpa ?? null;
        const temperature = tire?.temp_c ?? null;
        const tone = toneFor(pressure, targetKpa);

        return (
          <div key={position} className={styles.cell}>
            <div className={styles.cellHead}>
              <span className={styles.wheel} aria-hidden="true">
                {short}
              </span>
              <span className={styles.cellLabel}>{label}</span>
            </div>

            <p className={styles.pressure}>
              {isPresent(pressure) ? formatNumber(pressure, 1) : EMPTY}
              <span className={styles.unit}>kPa</span>
            </p>

            {showPsi && isPresent(pressure) && (
              <p className={styles.secondary}>{formatNumber(kpaToPsi(pressure), 1)} psi</p>
            )}

            <Meter
              value={pressure ?? min}
              min={min}
              max={max}
              tone={tone}
              label="Pressure"
              display={isPresent(pressure) ? `${formatNumber(pressure, 0)} kPa` : EMPTY}
              {...(targetKpa ? { target: targetKpa } : {})}
            />

            <div className={styles.footer}>
              <span className={styles.temp}>
                {isPresent(temperature) ? `${formatNumber(temperature, 1)} °C` : EMPTY}
              </span>
              {/* Status is never colour alone — the meter's tone is named here. */}
              <span className={styles.status}>{TONE_LABEL[tone]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
