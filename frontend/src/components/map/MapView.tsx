/**
 * MapLibre wrapper.
 *
 * The style document and every tile come from the backend proxy, so no map
 * credential exists in this bundle. `transformRequest` attaches the session
 * cookie because MapLibre issues tile requests through its own fetch, which
 * does not inherit the API client's defaults.
 *
 * Two modes:
 *   - `points`  plots telemetry readings, with optional selection
 *   - `picker`  a single draggable marker for choosing a location
 */
import maplibregl, { type LngLatLike, type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapStyleUrl, transformMapRequest } from '../../api/geo';
import styles from './MapView.module.css';

export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  /** Plain text; rendered into the DOM via textContent, never as HTML. */
  label: string;
  /** 0 = oldest, 1 = newest. Drives the sequential colour ramp. */
  recency?: number;
}

export interface MapViewProps {
  mode?: 'points' | 'picker';
  points?: MapPoint[];
  /** Picker mode: the current pin position. */
  marker?: { latitude: number; longitude: number } | null;
  onMarkerChange?: (position: { latitude: number; longitude: number }) => void;
  onPointClick?: (id: string) => void;
  height?: number | string;
  initialCenter?: [number, number];
  initialZoom?: number;
  /** Re-centres on this position when it changes (a search result, say). */
  flyTo?: { latitude: number; longitude: number; zoom?: number } | null;
  className?: string;
}

/** Blue sequential ramp, oldest → newest. */
const RECENCY_RAMP = ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];

function recencyColor(recency: number): string {
  const index = Math.min(
    RECENCY_RAMP.length - 1,
    Math.max(0, Math.round(recency * (RECENCY_RAMP.length - 1))),
  );
  return RECENCY_RAMP[index]!;
}

export function MapView({
  mode = 'points',
  points = [],
  marker = null,
  onMarkerChange,
  onPointClick,
  height = 320,
  initialCenter = [-71.0892, 42.3398],
  initialZoom = 11,
  flyTo = null,
  className,
}: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  // Callbacks in refs so the map is created once and never torn down by a
  // parent re-render handing down a new function identity.
  const onMarkerChangeRef = useRef(onMarkerChange);
  onMarkerChangeRef.current = onMarkerChange;
  const onPointClickRef = useRef(onPointClick);
  onPointClickRef.current = onPointClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: mapStyleUrl,
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: { compact: true },
        transformRequest: transformMapRequest,
      });
    } catch {
      setStatus('failed');
      return;
    }

    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => setStatus('ready'));
    // A failed style fetch means the proxy is unreachable or the session
    // lapsed. Surface a fallback rather than an empty grey box.
    map.on('error', (event) => {
      if (event.error && String(event.error.message ?? '').includes('style')) {
        setStatus('failed');
      }
    });

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // Created once; subsequent prop changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Picker mode: maintain a single draggable marker. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== 'picker') return;

    if (!marker) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const position: LngLatLike = [marker.longitude, marker.latitude];

    if (!markerRef.current) {
      const element = document.createElement('div');
      // CSS-module lookups are typed as possibly-undefined under
      // noUncheckedIndexedAccess; className needs a definite string.
      element.className = styles.pin ?? '';

      const created = new maplibregl.Marker({ element, draggable: true, anchor: 'bottom' })
        .setLngLat(position)
        .addTo(map);

      created.on('dragend', () => {
        const { lat, lng } = created.getLngLat();
        onMarkerChangeRef.current?.({ latitude: lat, longitude: lng });
      });

      markerRef.current = created;
    } else {
      markerRef.current.setLngLat(position);
    }
  }, [marker, mode]);

  /** Picker mode: clicking the map moves the pin. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== 'picker') return;

    const handler = (event: maplibregl.MapMouseEvent) => {
      onMarkerChangeRef.current?.({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
      });
    };

    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [mode]);

  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: points.map((point) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [point.longitude, point.latitude] },
        properties: {
          id: point.id,
          label: point.label,
          color: recencyColor(point.recency ?? 1),
        },
      })),
    }),
    [points],
  );

  /** Points mode: keep a GeoJSON source in sync with the readings. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== 'points' || status !== 'ready') return;

    const source = map.getSource('readings') as maplibregl.GeoJSONSource | undefined;

    if (source) {
      source.setData(geojson);
    } else {
      map.addSource('readings', { type: 'geojson', data: geojson });

      // A faint trail makes the sequence of readings legible as a path.
      map.addLayer({
        id: 'readings-halo',
        type: 'circle',
        source: 'readings',
        paint: {
          'circle-radius': 7,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.16,
        },
      });

      map.addLayer({
        id: 'readings-points',
        type: 'circle',
        source: 'readings',
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          // A 2px ring in the surface colour, matching the chart markers.
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#14161b',
        },
      });

      map.on('click', 'readings-points', (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;
        if (typeof id === 'string') onPointClickRef.current?.(id);
      });

      map.on('mouseenter', 'readings-points', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'readings-points', () => {
        map.getCanvas().style.cursor = '';
      });
    }
  }, [geojson, mode, status]);

  /** Fit the viewport to the plotted readings on first load. */
  const hasFitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== 'points' || status !== 'ready') return;
    if (hasFitted.current || points.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    for (const point of points) bounds.extend([point.longitude, point.latitude]);

    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
    hasFitted.current = true;
  }, [points, mode, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    map.flyTo({
      center: [flyTo.longitude, flyTo.latitude],
      zoom: flyTo.zoom ?? 14,
      duration: 900,
    });
  }, [flyTo]);

  return (
    <div className={[styles.wrapper, className ?? ''].filter(Boolean).join(' ')} style={{ height }}>
      <div ref={containerRef} className={styles.map} />

      {status === 'loading' && (
        <div className={styles.overlay}>
          <span className={styles.spinner} aria-hidden="true" />
          <p>Loading map…</p>
        </div>
      )}

      {status === 'failed' && (
        <div className={styles.overlay} role="status">
          <p className={styles.failedTitle}>Map unavailable</p>
          <p className={styles.failedBody}>
            The tile proxy could not be reached. Coordinates are still listed below.
          </p>
        </div>
      )}
    </div>
  );
}
