/**
 * Map tiles and geocoding — all proxied.
 *
 * There is no map SDK key in this bundle and no third-party map host in its
 * `connect-src`. MapLibre is pointed at the backend's style document, whose
 * tile URLs resolve back to the backend, which holds the upstream credential.
 */
import { config } from '../config';
import { request } from './client';
import type { GeoResult } from './types';

/** URL of the proxied MapLibre style document. */
export const mapStyleUrl = `${config.apiBaseUrl}/api/geo/style.json`;

export function searchPlaces(query: string, signal?: AbortSignal): Promise<{ results: GeoResult[] }> {
  return request<{ results: GeoResult[] }>('/api/geo/search', {
    query: { q: query },
    ...(signal ? { signal } : {}),
  });
}

/**
 * MapLibre `transformRequest` hook.
 *
 * The style and its tiles are authenticated routes, so every map request needs
 * the session cookie. MapLibre issues these through its own worker-side fetch,
 * which does not inherit our client's defaults — this is where credentials get
 * attached.
 */
export function transformMapRequest(url: string): { url: string; credentials: 'include' } | undefined {
  if (url.startsWith(config.apiBaseUrl)) {
    return { url, credentials: 'include' };
  }
  return undefined;
}
