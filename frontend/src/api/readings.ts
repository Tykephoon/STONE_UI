/** Reading queries. */
import { downloadFile, request } from './client';
import type {
  MetricName,
  ReadingDetailResponse,
  ReadingListResponse,
  SeriesBucket,
  SeriesResponse,
  StatsResponse,
} from './types';

export type SortColumn =
  | 'recorded_at'
  | 'received_at'
  | 'ambient_temp_c'
  | 'humidity_pct'
  | 'battery_voltage_v'
  | 'barometric_pressure_hpa'
  | 'clock_skew_ms';

export interface ReadingFilters {
  device_id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}

export interface ListReadingsParams extends ReadingFilters {
  sort?: SortColumn;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function listReadings(
  params: ListReadingsParams = {},
  signal?: AbortSignal,
): Promise<ReadingListResponse> {
  return request<ReadingListResponse>('/api/readings', {
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

export function getReading(id: string, signal?: AbortSignal): Promise<ReadingDetailResponse> {
  return request<ReadingDetailResponse>(`/api/readings/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
  });
}

export function getStats(
  filters: ReadingFilters = {},
  signal?: AbortSignal,
): Promise<StatsResponse> {
  return request<StatsResponse>('/api/readings/stats', {
    query: { ...filters },
    ...(signal ? { signal } : {}),
  });
}

export function getSeries(
  params: ReadingFilters & {
    metrics: MetricName[];
    bucket?: SeriesBucket;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<SeriesResponse> {
  const { metrics, ...rest } = params;
  return request<SeriesResponse>('/api/readings/series', {
    query: { ...rest, metrics: metrics.join(',') },
    ...(signal ? { signal } : {}),
  });
}

export function exportReadings(
  filters: ReadingFilters & { format: 'csv' | 'json'; limit?: number },
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  return downloadFile('/api/readings/export', { ...filters }, `readings-${stamp}.${filters.format}`);
}
