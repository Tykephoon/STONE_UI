/**
 * Telemetry overview.
 *
 * Layout reads top to bottom by urgency: what is the state right now, is
 * anything wrong with the tyres, how have the sensors trended, and where was
 * the data collected.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSeries, getStats, listDevices, listReadings, onDataChange } from '../../data/store';
import type { MetricName } from '../../data/types';
import { StatTile } from '../../components/charts/StatTile';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { FilterBar } from '../../components/filters/FilterBar';
import { BatteryIcon, ClockIcon, InboxIcon, MapPinIcon } from '../../components/layout/Icons';
import { LazyMapView, type MapPoint } from '../../components/map/LazyMapView';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState, ErrorState, Skeleton, StatusDot } from '../../components/ui/Feedback';
import { Toggle } from '../../components/ui/Form';
import { useAsync } from '../../hooks/useAsync';
import { useLocalPreference } from '../../hooks/useLocalPreference';
import { EMPTY, formatCount, formatMetric, formatNumber, formatSkew } from '../../lib/format';
import {
  type RangePreset,
  bucketForRange,
  formatDateTime,
  formatRelative,
  rangeFromPreset,
  LOCAL_TIME_ZONE,
} from '../../lib/time';
import { TireGrid } from './TireGrid';
import styles from './DashboardPage.module.css';

const TIRE_PRESSURE_METRICS: MetricName[] = [
  'tire_fl_pressure_kpa',
  'tire_fr_pressure_kpa',
  'tire_rl_pressure_kpa',
  'tire_rr_pressure_kpa',
];

const TIRE_LABELS = ['Front left', 'Front right', 'Rear left', 'Rear right'];

export function DashboardPage(): JSX.Element {
  const navigate = useNavigate();

  const [range, setRange] = useLocalPreference<RangePreset>('dashboard.range', '24h');
  const [deviceId, setDeviceId] = useLocalPreference<string>('dashboard.device', '');
  const [showPsi, setShowPsi] = useLocalPreference('dashboard.psi', false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const timeRange = useMemo(() => rangeFromPreset(range), [range]);
  const bucket = bucketForRange(range);
  const filters = useMemo(
    () => ({ ...timeRange, ...(deviceId ? { device_id: deviceId } : {}) }),
    [timeRange, deviceId],
  );

  const devicesState = useAsync((signal) => listDevices(signal), []);
  const devices = devicesState.data?.devices ?? [];

  const statsState = useAsync(
    (signal) => getStats(filters, signal),
    [filters, refreshNonce],
  );

  const sensorSeries = useAsync(
    (signal) =>
      getSeries(
        { ...filters, metrics: ['ambient_temp_c', 'humidity_pct'], bucket, limit: 400 },
        signal,
      ),
    [filters, bucket, refreshNonce],
  );

  const tireSeries = useAsync(
    (signal) =>
      getSeries({ ...filters, metrics: TIRE_PRESSURE_METRICS, bucket, limit: 400 }, signal),
    [filters, bucket, refreshNonce],
  );

  const batterySeries = useAsync(
    (signal) =>
      getSeries({ ...filters, metrics: ['battery_voltage_v'], bucket, limit: 400 }, signal),
    [filters, bucket, refreshNonce],
  );

  const recentState = useAsync(
    (signal) => listReadings({ ...filters, limit: 80, sort: 'recorded_at', order: 'desc' }, signal),
    [filters, refreshNonce],
  );

  /*
    Data only changes when the user imports or deletes something, so the
    dashboard subscribes to those events rather than polling — there is no
    server that could produce a new reading behind its back.
  */
  const reloadAll = useCallback(() => setRefreshNonce((value) => value + 1), []);
  useEffect(() => onDataChange(reloadAll), [reloadAll]);

  const stats = statsState.data;
  const readings = recentState.data?.readings ?? [];
  const latest = readings[0] ?? null;

  const lastRecordedAt = stats?.last_recorded_at ?? null;

  /** Average of the four wheels, used as the tyre-target reference. */
  const averageTarget = useMemo(() => {
    if (!stats) return null;
    const values = TIRE_PRESSURE_METRICS.map((metric) => stats.metrics[metric]?.avg).filter(
      (value): value is number => typeof value === 'number',
    );
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [stats]);

  const mapPoints = useMemo<MapPoint[]>(() => {
    if (readings.length === 0) return [];
    const newest = Date.parse(readings[0]!.recorded_at);
    const oldest = Date.parse(readings[readings.length - 1]!.recorded_at);
    const span = newest - oldest || 1;

    return readings.map((reading) => ({
      id: reading.id,
      latitude: reading.location.latitude,
      longitude: reading.location.longitude,
      label: reading.device_name,
      recency: (Date.parse(reading.recorded_at) - oldest) / span,
    }));
  }, [readings]);

  const toTimestamps = (points: { bucket: string }[]) =>
    points.map((point) => Date.parse(point.bucket));

  const seriesValues = (points: Record<string, unknown>[], metric: string): (number | null)[] =>
    points.map((point) => {
      const value = point[metric];
      return typeof value === 'number' ? value : null;
    });

  const batteryTrend = useMemo(
    () => seriesValues(batterySeries.data?.points ?? [], 'battery_voltage_v').slice(-12),
    [batterySeries.data],
  );

  const temperatureTrend = useMemo(
    () => seriesValues(sensorSeries.data?.points ?? [], 'ambient_temp_c').slice(-12),
    [sensorSeries.data],
  );

  const hasAnyDevice = devices.length > 0;
  const hasAnyReading = (stats?.total ?? 0) > 0;

  if (devicesState.isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.tiles}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={104} radius="var(--radius-lg)" />
          ))}
        </div>
        <Skeleton height={280} radius="var(--radius-lg)" />
      </div>
    );
  }

  if (devicesState.error) {
    return (
      <div className={styles.page}>
        <ErrorState error={devicesState.error} onRetry={devicesState.reload} />
      </div>
    );
  }

  if (!hasAnyDevice) {
    return (
      <div className={styles.page}>
        <EmptyState
          icon={<InboxIcon size={22} />}
          title="No data yet"
          description="Import a CSV of readings, paste rows from a spreadsheet, or enter one by hand. Everything stays in this browser."
          action={
            <Link to="/import" className={styles.ctaLink}>
              Import data →
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Dashboard</h1>
          <p className={styles.subtitle}>
            <span className={styles.liveIndicator}>
              <StatusDot tone={stats && stats.total > 0 ? 'good' : 'neutral'} />
              {formatCount(stats?.total ?? 0)} readings stored locally
            </span>
            {lastRecordedAt && (
              <>
                <span className={styles.separator}>·</span>
                <span title={formatDateTime(lastRecordedAt)}>
                  last reading {formatRelative(lastRecordedAt)}
                </span>
              </>
            )}
            <span className={styles.separator}>·</span>
            <span>times in {LOCAL_TIME_ZONE}</span>
          </p>
        </div>
      </header>

      <FilterBar
        devices={devices}
        deviceId={deviceId}
        onDeviceChange={setDeviceId}
        range={range}
        onRangeChange={setRange}
      />

      {statsState.error && <ErrorState error={statsState.error} onRetry={statsState.reload} />}

      <section className={styles.tiles} aria-label="Summary statistics">
        <StatTile
          label="Readings in range"
          value={formatCount(stats?.total ?? null)}
          isLoading={statsState.isLoading}
          footnote={
            stats?.first_recorded_at
              ? `since ${formatRelative(stats.first_recorded_at)}`
              : 'no data yet'
          }
          icon={<InboxIcon size={14} />}
        />

        <StatTile
          label="Ambient temperature"
          value={formatNumber(stats?.metrics.ambient_temp_c?.avg ?? null, 1)}
          unit="°C"
          isLoading={statsState.isLoading}
          trend={temperatureTrend}
          trendColor="var(--series-2)"
          footnote={
            stats?.metrics.ambient_temp_c
              ? `${formatNumber(stats.metrics.ambient_temp_c.min, 1)} – ${formatNumber(stats.metrics.ambient_temp_c.max, 1)} °C`
              : undefined
          }
        />

        <StatTile
          label="Battery"
          value={formatNumber(latest?.sensors.battery_voltage_v ?? null, 2)}
          unit="V"
          isLoading={recentState.isLoading}
          trend={batteryTrend}
          trendColor="var(--series-3)"
          icon={<BatteryIcon size={14} />}
          footnote={
            stats?.metrics.battery_voltage_v
              ? `min ${formatNumber(stats.metrics.battery_voltage_v.min, 2)} V`
              : undefined
          }
        />

        <StatTile
          label="Device clock skew"
          value={formatSkew(stats?.metrics.clock_skew_ms?.avg ?? null)}
          isLoading={statsState.isLoading}
          icon={<ClockIcon size={14} />}
          footnote="average, device vs. server"
        />
      </section>

      {!hasAnyReading && !statsState.isLoading ? (
        <Card>
          <EmptyState
            compact
            icon={<InboxIcon size={22} />}
            title="No readings in this range"
            description="Widen the time range, or check that the device is posting to the ingest endpoint."
          />
        </Card>
      ) : (
        <>
          <div className={styles.split}>
            <Card>
              <CardHeader
                title="Tyre pressure"
                subtitle={
                  latest
                    ? `Latest reading · ${formatDateTime(latest.recorded_at)}`
                    : 'Awaiting a reading'
                }
                actions={
                  <Toggle label="psi" checked={showPsi} onChange={setShowPsi} />
                }
              />
              <CardBody>
                <TireGrid reading={latest} targetKpa={averageTarget} showPsi={showPsi} />
                {averageTarget !== null && (
                  <p className={styles.note}>
                    Severity is measured against the range average of{' '}
                    {formatNumber(averageTarget, 0)} kPa, shown as a marker on each meter.
                  </p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Where readings were taken"
                subtitle={`${readings.length} most recent positions, oldest to newest`}
              />
              <CardBody>
                <LazyMapView
                  points={mapPoints}
                  height={300}
                  onPointClick={(id) => navigate(`/readings/${id}`)}
                />
                {latest && (
                  <p className={styles.note}>
                    <MapPinIcon size={13} /> Latest: {formatNumber(latest.location.latitude, 5)},{' '}
                    {formatNumber(latest.location.longitude, 5)}
                    {latest.location.gps_accuracy_m !== null &&
                      ` · ±${formatNumber(latest.location.gps_accuracy_m, 1)} m`}
                  </p>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Tyre pressure over time"
              subtitle={`Averaged per ${bucket === 'raw' ? 'reading' : bucket}`}
            />
            <CardBody>
              {tireSeries.error ? (
                <ErrorState error={tireSeries.error} onRetry={tireSeries.reload} compact />
              ) : (
                <TimeSeriesChart
                  ariaLabel="Tyre pressure for each wheel over the selected time range"
                  timestamps={toTimestamps(tireSeries.data?.points ?? [])}
                  height={260}
                  series={TIRE_PRESSURE_METRICS.map((metric, index) => ({
                    key: metric,
                    label: TIRE_LABELS[index]!,
                    values: seriesValues(tireSeries.data?.points ?? [], metric),
                    unit: 'kPa',
                    digits: 1,
                  }))}
                />
              )}
            </CardBody>
          </Card>

          {/*
            Temperature and humidity are separate charts rather than one chart
            with two y-axes: a shared plot would make the two lines appear to
            cross meaningfully when the crossing is an artefact of the scales.
          */}
          <div className={styles.split}>
            <Card>
              <CardHeader title="Ambient temperature" subtitle="°C" />
              <CardBody>
                {sensorSeries.error ? (
                  <ErrorState error={sensorSeries.error} onRetry={sensorSeries.reload} compact />
                ) : (
                  <TimeSeriesChart
                    ariaLabel="Ambient temperature over the selected time range"
                    timestamps={toTimestamps(sensorSeries.data?.points ?? [])}
                    height={200}
                    showArea
                    series={[
                      {
                        key: 'ambient_temp_c',
                        label: 'Ambient temperature',
                        values: seriesValues(sensorSeries.data?.points ?? [], 'ambient_temp_c'),
                        unit: '°C',
                        digits: 1,
                      },
                    ]}
                  />
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Relative humidity" subtitle="%" />
              <CardBody>
                {sensorSeries.error ? (
                  <ErrorState error={sensorSeries.error} onRetry={sensorSeries.reload} compact />
                ) : (
                  <TimeSeriesChart
                    ariaLabel="Relative humidity over the selected time range"
                    timestamps={toTimestamps(sensorSeries.data?.points ?? [])}
                    height={200}
                    showArea
                    series={[
                      {
                        key: 'humidity_pct',
                        label: 'Humidity',
                        values: seriesValues(sensorSeries.data?.points ?? [], 'humidity_pct'),
                        unit: '%',
                        digits: 1,
                      },
                    ]}
                  />
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Battery voltage" subtitle="V" />
            <CardBody>
              <TimeSeriesChart
                ariaLabel="Battery voltage over the selected time range"
                timestamps={toTimestamps(batterySeries.data?.points ?? [])}
                height={190}
                showArea
                series={[
                  {
                    key: 'battery_voltage_v',
                    label: 'Battery',
                    values: seriesValues(batterySeries.data?.points ?? [], 'battery_voltage_v'),
                    unit: 'V',
                    digits: 2,
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Card flush>
            <CardHeader
              title="Latest readings"
              subtitle="Most recent first"
              actions={
                <Link className={styles.ctaLink} to="/readings">
                  View all →
                </Link>
              }
            />
            <CardBody>
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Recorded</th>
                      <th scope="col">Device</th>
                      <th scope="col">Ambient</th>
                      <th scope="col">Humidity</th>
                      <th scope="col">Battery</th>
                      <th scope="col">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readings.slice(0, 8).map((reading) => (
                      <tr
                        key={reading.id}
                        className={styles.row}
                        onClick={() => navigate(`/readings/${reading.id}`)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') navigate(`/readings/${reading.id}`);
                        }}
                      >
                        <td title={formatDateTime(reading.recorded_at)}>
                          {formatRelative(reading.recorded_at)}
                        </td>
                        {/* Device names come from user input; React escapes them as text. */}
                        <td className={styles.deviceCell}>{reading.device_name}</td>
                        <td>{formatMetric('ambient_temp_c', reading.sensors.ambient_temp_c)}</td>
                        <td>{formatMetric('humidity_pct', reading.sensors.humidity_pct)}</td>
                        <td>
                          {formatMetric('battery_voltage_v', reading.sensors.battery_voltage_v)}
                        </td>
                        <td className={styles.mono}>
                          {formatNumber(reading.location.latitude, 4)},{' '}
                          {formatNumber(reading.location.longitude, 4)}
                        </td>
                      </tr>
                    ))}
                    {readings.length === 0 && (
                      <tr>
                        <td colSpan={6} className={styles.emptyRow}>
                          {EMPTY}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
