/**
 * A single reading, in full.
 *
 * Every stored field appears here, including the raw `extra` JSON the device
 * sent. Values are rendered as text throughout — device-supplied strings reach
 * the DOM through React's normal escaping and never through a markup sink.
 */
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getReading } from '../../data/store';
import type { TirePosition } from '../../data/types';
import { Meter } from '../../components/charts/Meter';
import { ChevronLeftIcon, ChevronRightIcon, MapPinIcon } from '../../components/layout/Icons';
import { LazyMapView } from '../../components/map/LazyMapView';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Badge, ErrorState, LoadingPanel } from '../../components/ui/Feedback';
import { useAsync } from '../../hooks/useAsync';
import {
  EMPTY,
  accelerationMagnitude,
  celsiusToFahrenheit,
  formatLatLon,
  formatMetric,
  formatNumber,
  formatSkew,
  formatUnknown,
  humaniseKey,
  isPresent,
  kpaToPsi,
} from '../../lib/format';
import { LOCAL_TIME_ZONE, formatDateTime, formatPrecise, formatRelative } from '../../lib/time';
import styles from './ReadingDetailPage.module.css';

const TIRE_LABELS: Record<TirePosition, string> = {
  front_left: 'Front left',
  front_right: 'Front right',
  rear_left: 'Rear left',
  rear_right: 'Rear right',
};

interface FieldRowProps {
  label: string;
  value: string;
  secondary?: string | undefined;
}

function FieldRow({ label, value, secondary }: FieldRowProps): JSX.Element {
  return (
    <div className={styles.fieldRow}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>
        {value}
        {secondary && <span className={styles.fieldSecondary}>{secondary}</span>}
      </dd>
    </div>
  );
}

export function ReadingDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const state = useAsync((signal) => getReading(id!, signal), [id], { enabled: Boolean(id) });

  const reading = state.data?.reading;
  const neighbours = state.data?.neighbours;

  const accelMagnitude = useMemo(
    () =>
      reading
        ? accelerationMagnitude(
            reading.sensors.accel_x_g,
            reading.sensors.accel_y_g,
            reading.sensors.accel_z_g,
          )
        : null,
    [reading],
  );

  const extraEntries = useMemo(
    () => (reading ? Object.entries(reading.extra) : []),
    [reading],
  );

  const rawJson = useMemo(() => {
    if (!reading) return '';
    try {
      return JSON.stringify(reading, null, 2);
    } catch {
      return '';
    }
  }, [reading]);

  if (state.isLoading) return <LoadingPanel label="Loading reading" />;

  if (state.error || !reading) {
    return (
      <div className={styles.page}>
        <ErrorState error={state.error} onRetry={state.reload} />
        <Button variant="secondary" onClick={() => navigate('/readings')}>
          Back to readings
        </Button>
      </div>
    );
  }

  const pressures = Object.values(reading.tires)
    .map((tire) => tire.pressure_kpa)
    .filter(isPresent);
  const averagePressure =
    pressures.length > 0
      ? pressures.reduce((sum, value) => sum + value, 0) / pressures.length
      : null;

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link to="/readings" className={styles.breadcrumbLink}>
          Readings
        </Link>
        <span aria-hidden="true">/</span>
        <span className={styles.breadcrumbCurrent}>{reading.id}</span>
      </nav>

      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{formatDateTime(reading.recorded_at)}</h1>
          <p className={styles.subtitle}>
            <Badge tone="neutral">{reading.device_name}</Badge>
            <span>{formatRelative(reading.recorded_at)}</span>
            <span className={styles.separator}>·</span>
            <span>{LOCAL_TIME_ZONE}</span>
          </p>
        </div>

        <div className={styles.navButtons}>
          <Button
            size="sm"
            variant="secondary"
            disabled={!neighbours?.older_id}
            onClick={() => neighbours?.older_id && navigate(`/readings/${neighbours.older_id}`)}
            iconLeft={<ChevronLeftIcon size={15} />}
          >
            Older
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!neighbours?.newer_id}
            onClick={() => neighbours?.newer_id && navigate(`/readings/${neighbours.newer_id}`)}
            iconRight={<ChevronRightIcon size={15} />}
          >
            Newer
          </Button>
        </div>
      </header>

      <div className={styles.grid}>
        {/*
          Both clocks side by side with the skew between them: a device whose
          clock has drifted produces data that looks fine until someone
          correlates it with another source.
        */}
        <Card>
          <CardHeader title="Timing" level={3} />
          <CardBody>
            <dl className={styles.fieldList}>
              <FieldRow
                label="Recorded (device clock)"
                value={formatPrecise(reading.recorded_at)}
              />
              <FieldRow
                label="Received (server clock)"
                value={formatPrecise(reading.received_at)}
              />
              <FieldRow
                label="Clock skew"
                value={formatSkew(reading.clock_skew_ms)}
                secondary={
                  Math.abs(reading.clock_skew_ms) > 60_000
                    ? 'device clock is well out of step'
                    : undefined
                }
              />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Location" level={3} />
          <CardBody>
            <dl className={styles.fieldList}>
              <FieldRow
                label="Coordinates"
                value={formatLatLon(reading.location.latitude, reading.location.longitude)}
              />
              <FieldRow
                label="Altitude"
                value={formatMetric('altitude_m', reading.location.altitude_m)}
              />
              <FieldRow
                label="GPS accuracy"
                value={formatMetric('gps_accuracy_m', reading.location.gps_accuracy_m)}
              />
            </dl>
            <div className={styles.mapWrap}>
              <LazyMapView
                points={[
                  {
                    id: reading.id,
                    latitude: reading.location.latitude,
                    longitude: reading.location.longitude,
                    label: reading.device_name,
                    recency: 1,
                  },
                ]}
                height={200}
                initialCenter={[reading.location.longitude, reading.location.latitude]}
                initialZoom={14}
              />
            </div>
            <p className={styles.note}>
              <MapPinIcon size={13} /> Position as reported by the device at capture time.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Tyres"
          subtitle={
            averagePressure !== null
              ? `Average ${formatNumber(averagePressure, 1)} kPa across four wheels`
              : 'No tyre data in this reading'
          }
          level={3}
        />
        <CardBody>
          <div className={styles.tireList}>
            {(Object.keys(TIRE_LABELS) as TirePosition[]).map((position) => {
              const tire = reading.tires[position];
              const pressure = tire.pressure_kpa;

              return (
                <div key={position} className={styles.tireItem}>
                  <p className={styles.tireName}>{TIRE_LABELS[position]}</p>
                  <p className={styles.tireValue}>
                    {isPresent(pressure) ? formatNumber(pressure, 1) : EMPTY}
                    <span className={styles.tireUnit}>kPa</span>
                  </p>
                  <p className={styles.tireSecondary}>
                    {isPresent(pressure) ? `${formatNumber(kpaToPsi(pressure), 1)} psi` : EMPTY}
                  </p>
                  {averagePressure !== null && isPresent(pressure) && (
                    <Meter
                      value={pressure}
                      min={averagePressure * 0.7}
                      max={averagePressure * 1.3}
                      target={averagePressure}
                      tone={
                        Math.abs(pressure - averagePressure) / averagePressure <= 0.05
                          ? 'good'
                          : Math.abs(pressure - averagePressure) / averagePressure <= 0.1
                            ? 'warning'
                            : 'serious'
                      }
                      label="Deviation from average"
                      display={`${pressure > averagePressure ? '+' : ''}${formatNumber(
                        pressure - averagePressure,
                        1,
                      )} kPa`}
                    />
                  )}
                  <p className={styles.tireTemp}>
                    Temperature{' '}
                    <strong>
                      {isPresent(tire.temp_c) ? `${formatNumber(tire.temp_c, 1)} °C` : EMPTY}
                    </strong>
                  </p>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <div className={styles.grid}>
        <Card>
          <CardHeader title="Environment" level={3} />
          <CardBody>
            <dl className={styles.fieldList}>
              <FieldRow
                label="Ambient temperature"
                value={formatMetric('ambient_temp_c', reading.sensors.ambient_temp_c)}
                secondary={
                  isPresent(reading.sensors.ambient_temp_c)
                    ? `${formatNumber(celsiusToFahrenheit(reading.sensors.ambient_temp_c), 1)} °F`
                    : undefined
                }
              />
              <FieldRow
                label="Relative humidity"
                value={formatMetric('humidity_pct', reading.sensors.humidity_pct)}
              />
              <FieldRow
                label="Barometric pressure"
                value={formatMetric(
                  'barometric_pressure_hpa',
                  reading.sensors.barometric_pressure_hpa,
                )}
              />
              <FieldRow
                label="Battery voltage"
                value={formatMetric('battery_voltage_v', reading.sensors.battery_voltage_v)}
              />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Acceleration"
            subtitle={
              accelMagnitude !== null
                ? `Vector magnitude ${formatNumber(accelMagnitude, 3)} g`
                : undefined
            }
            level={3}
          />
          <CardBody>
            <dl className={styles.fieldList}>
              <FieldRow label="X axis" value={formatMetric('accel_x_g', reading.sensors.accel_x_g)} />
              <FieldRow label="Y axis" value={formatMetric('accel_y_g', reading.sensors.accel_y_g)} />
              <FieldRow label="Z axis" value={formatMetric('accel_z_g', reading.sensors.accel_z_g)} />
              <FieldRow
                label="Magnitude"
                value={accelMagnitude !== null ? `${formatNumber(accelMagnitude, 3)} g` : EMPTY}
                secondary={
                  accelMagnitude !== null && Math.abs(accelMagnitude - 1) < 0.05
                    ? 'consistent with stationary'
                    : undefined
                }
              />
            </dl>
          </CardBody>
        </Card>
      </div>

      {/*
        Fields the schema does not name. Preserved by the ingest endpoint rather
        than dropped, so a firmware revision that adds a sensor is visible here
        immediately without a backend change.
      */}
      <Card>
        <CardHeader
          title="Additional device fields"
          subtitle={
            extraEntries.length > 0
              ? `${extraEntries.length} field${extraEntries.length === 1 ? '' : 's'} outside the standard schema`
              : 'This device sent only standard fields'
          }
          level={3}
        />
        <CardBody>
          {extraEntries.length === 0 ? (
            <p className={styles.muted}>Nothing extra was included with this reading.</p>
          ) : (
            <dl className={styles.fieldList}>
              {extraEntries.map(([key, value]) => (
                <FieldRow key={key} label={humaniseKey(key)} value={formatUnknown(value)} />
              ))}
            </dl>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Raw record" subtitle="Exactly as the API returned it" level={3} />
        <CardBody>
          {/*
            Rendered as a text child of <pre>, never via innerHTML. Device
            content cannot become markup on this path.
          */}
          <pre className={styles.rawJson}>{rawJson}</pre>
        </CardBody>
      </Card>
    </div>
  );
}
