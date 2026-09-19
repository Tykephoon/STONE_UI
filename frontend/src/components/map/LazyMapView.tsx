/**
 * Deferred map loader.
 *
 * MapLibre is ~280 kB gzipped — larger than the rest of the application put
 * together. Loading it eagerly would delay first paint of the charts, which are
 * what the dashboard is actually for. This wrapper defers the chunk until a map
 * is genuinely rendered, and shows a sized placeholder meanwhile so the layout
 * does not jump when it arrives.
 */
import { Suspense, lazy } from 'react';
import type { MapViewProps } from './MapView';
import styles from './MapView.module.css';

const MapView = lazy(() =>
  import('./MapView').then((module) => ({ default: module.MapView })),
);

export type { MapPoint, MapViewProps } from './MapView';

export function LazyMapView(props: MapViewProps): JSX.Element {
  const height = props.height ?? 320;

  return (
    <Suspense
      fallback={
        <div className={styles.wrapper} style={{ height }}>
          <div className={styles.overlay}>
            <span className={styles.spinner} aria-hidden="true" />
            <p>Loading map…</p>
          </div>
        </div>
      }
    >
      <MapView {...props} />
    </Suspense>
  );
}
