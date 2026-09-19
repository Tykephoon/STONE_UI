/**
 * Readings table: filter, search, sort, paginate, export.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { listDevices } from '../../api/devices';
import { type SortColumn, exportReadings, listReadings } from '../../api/readings';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback';
import { FilterBar } from '../../components/filters/FilterBar';
import { DownloadIcon, InboxIcon, RefreshIcon } from '../../components/layout/Icons';
import { useToast } from '../../components/ui/Toast';
import { useAsync } from '../../hooks/useAsync';
import { useDebounced } from '../../hooks/useDebounced';
import { formatMetric, formatNumber, formatSkew } from '../../lib/format';
import {
  type RangePreset,
  LOCAL_TIME_ZONE,
  formatDateTime,
  rangeFromPreset,
} from '../../lib/time';
import styles from './ReadingsPage.module.css';

const PAGE_SIZE = 50;

interface Column {
  key: SortColumn | 'position' | 'tires';
  label: string;
  sortable: boolean;
  align?: 'right';
}

const COLUMNS: Column[] = [
  { key: 'recorded_at', label: 'Recorded', sortable: true },
  { key: 'received_at', label: 'Received', sortable: true },
  { key: 'clock_skew_ms', label: 'Skew', sortable: true, align: 'right' },
  { key: 'ambient_temp_c', label: 'Ambient', sortable: true, align: 'right' },
  { key: 'humidity_pct', label: 'Humidity', sortable: true, align: 'right' },
  { key: 'barometric_pressure_hpa', label: 'Pressure', sortable: true, align: 'right' },
  { key: 'battery_voltage_v', label: 'Battery', sortable: true, align: 'right' },
  { key: 'tires', label: 'Tyres (FL/FR/RL/RR)', sortable: false, align: 'right' },
  { key: 'position', label: 'Position', sortable: false },
];

export function ReadingsPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [range, setRange] = useState<RangePreset>(
    (searchParams.get('range') as RangePreset | null) ?? '7d',
  );
  const [deviceId, setDeviceId] = useState(searchParams.get('device') ?? '');
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const [sort, setSort] = useState<SortColumn>('recorded_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const debouncedSearch = useDebounced(search, 320);

  /** Keep the URL in step so a filtered view can be linked and reloaded. */
  useEffect(() => {
    const next = new URLSearchParams();
    if (range !== '7d') next.set('range', range);
    if (deviceId) next.set('device', deviceId);
    if (debouncedSearch) next.set('q', debouncedSearch);
    setSearchParams(next, { replace: true });
  }, [range, deviceId, debouncedSearch, setSearchParams]);

  // Any filter change invalidates the current page number.
  useEffect(() => {
    setOffset(0);
  }, [range, deviceId, debouncedSearch, sort, order]);

  const filters = useMemo(
    () => ({
      ...rangeFromPreset(range),
      ...(deviceId ? { device_id: deviceId } : {}),
      ...(debouncedSearch ? { q: debouncedSearch } : {}),
    }),
    [range, deviceId, debouncedSearch],
  );

  const devicesState = useAsync((signal) => listDevices(signal), []);
  const devices = devicesState.data?.devices ?? [];

  const readingsState = useAsync(
    (signal) => listReadings({ ...filters, sort, order, limit: PAGE_SIZE, offset }, signal),
    [filters, sort, order, offset],
  );

  const readings = readingsState.data?.readings ?? [];
  const page = readingsState.data?.page;

  const toggleSort = useCallback(
    (column: SortColumn) => {
      if (sort === column) {
        setOrder((current) => (current === 'desc' ? 'asc' : 'desc'));
      } else {
        setSort(column);
        setOrder('desc');
      }
    },
    [sort],
  );

  const handleExport = useCallback(
    async (format: 'csv' | 'json') => {
      setIsExporting(true);
      try {
        await exportReadings({ ...filters, format });
        toast.success('Export started', `Your ${format.toUpperCase()} download should begin.`);
      } catch {
        toast.error('Export failed', 'The file could not be generated. Try a narrower range.');
      } finally {
        setIsExporting(false);
      }
    },
    [filters, toast],
  );

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + readings.length, total);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Readings</h1>
          <p className={styles.subtitle}>
            Every reading your devices have posted. Times shown in {LOCAL_TIME_ZONE}.
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            size="sm"
            variant="ghost"
            onClick={readingsState.reload}
            iconLeft={<RefreshIcon size={15} />}
            isLoading={readingsState.isFetching && !readingsState.isLoading}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleExport('csv')}
            isLoading={isExporting}
            iconLeft={<DownloadIcon size={15} />}
          >
            CSV
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => handleExport('json')}
            isLoading={isExporting}
          >
            JSON
          </Button>
        </div>
      </header>

      <FilterBar
        devices={devices}
        deviceId={deviceId}
        onDeviceChange={setDeviceId}
        range={range}
        onRangeChange={setRange}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search id, device, or extra fields…"
      />

      {readingsState.error ? (
        <ErrorState error={readingsState.error} onRetry={readingsState.reload} />
      ) : (
        <Card flush>
          <CardBody>
            {readingsState.isLoading ? (
              <div className={styles.skeletonWrap}>
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} height={34} />
                ))}
              </div>
            ) : readings.length === 0 ? (
              <EmptyState
                compact
                icon={<InboxIcon size={22} />}
                title="No readings match these filters"
                description={
                  debouncedSearch
                    ? 'Try a different search term, or widen the time range.'
                    : 'Widen the time range, or check that the device is posting.'
                }
              />
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => {
                        const isSorted = column.sortable && sort === column.key;
                        return (
                          <th
                            key={column.key}
                            scope="col"
                            className={column.align === 'right' ? styles.right : undefined}
                            aria-sort={
                              isSorted ? (order === 'asc' ? 'ascending' : 'descending') : undefined
                            }
                          >
                            {column.sortable ? (
                              <button
                                type="button"
                                className={styles.sortButton}
                                onClick={() => toggleSort(column.key as SortColumn)}
                              >
                                {column.label}
                                <span
                                  className={[
                                    styles.sortIcon,
                                    isSorted ? styles.sortIconActive : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                  aria-hidden="true"
                                >
                                  {isSorted ? (order === 'asc' ? '↑' : '↓') : '↕'}
                                </span>
                              </button>
                            ) : (
                              column.label
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map((reading) => (
                      <tr
                        key={reading.id}
                        className={styles.row}
                        tabIndex={0}
                        onClick={() => navigate(`/readings/${reading.id}`)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') navigate(`/readings/${reading.id}`);
                        }}
                      >
                        <td>
                          <span className={styles.primaryCell}>
                            {formatDateTime(reading.recorded_at)}
                          </span>
                          <span className={styles.secondaryCell}>{reading.device_name}</span>
                        </td>
                        <td className={styles.muted}>{formatDateTime(reading.received_at)}</td>
                        <td className={styles.right}>{formatSkew(reading.clock_skew_ms)}</td>
                        <td className={styles.right}>
                          {formatMetric('ambient_temp_c', reading.sensors.ambient_temp_c)}
                        </td>
                        <td className={styles.right}>
                          {formatMetric('humidity_pct', reading.sensors.humidity_pct)}
                        </td>
                        <td className={styles.right}>
                          {formatMetric(
                            'barometric_pressure_hpa',
                            reading.sensors.barometric_pressure_hpa,
                          )}
                        </td>
                        <td className={styles.right}>
                          {formatMetric('battery_voltage_v', reading.sensors.battery_voltage_v)}
                        </td>
                        <td className={[styles.right, styles.mono].join(' ')}>
                          {[
                            reading.tires.front_left.pressure_kpa,
                            reading.tires.front_right.pressure_kpa,
                            reading.tires.rear_left.pressure_kpa,
                            reading.tires.rear_right.pressure_kpa,
                          ]
                            .map((value) => formatNumber(value, 0))
                            .join(' / ')}
                        </td>
                        <td className={styles.mono}>
                          {formatNumber(reading.location.latitude, 4)},{' '}
                          {formatNumber(reading.location.longitude, 4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {total > 0 && (
        <nav className={styles.pagination} aria-label="Pagination">
          <p className={styles.pageInfo}>
            Showing <strong>{from.toLocaleString()}</strong>–<strong>{to.toLocaleString()}</strong>{' '}
            of <strong>{total.toLocaleString()}</strong>
          </p>
          <div className={styles.pageButtons}>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!page?.has_more}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
