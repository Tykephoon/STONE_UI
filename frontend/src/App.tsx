/**
 * Routing.
 *
 * A `HashRouter` is used because the app is served from GitHub Pages, which has
 * no server-side rewrite: a deep link to `/readings/rdg_123` under a history
 * router would ask Pages for a file that does not exist. The build also writes
 * a `404.html` copy of `index.html` as a second line of defence for anyone
 * arriving on a path-style URL.
 *
 * There are no route guards and no authentication: the app has no server and
 * all data lives in the visitor's own browser.
 *
 * Heavy routes are lazily loaded so the three.js and maplibre chunks are not
 * downloaded by someone who only ever opens the dashboard.
 */
import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { LoadingPanel } from './components/ui/Feedback';
import { ToastProvider } from './components/ui/Toast';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { DevicesPage } from './features/devices/DevicesPage';
import { ImportPage } from './features/import/ImportPage';
import { NotFoundPage } from './features/misc/NotFoundPage';
import { ReadingDetailPage } from './features/readings/ReadingDetailPage';
import { ReadingsPage } from './features/readings/ReadingsPage';
import { ErrorBoundary } from './components/ErrorBoundary';

// The studio pulls in three.js; the shared viewer pulls the same chunk.
const StudioPage = lazy(() =>
  import('./features/studio/StudioPage').then((module) => ({ default: module.StudioPage })),
);
const SharedDesignPage = lazy(() =>
  import('./features/studio/SharedDesignPage').then((module) => ({
    default: module.SharedDesignPage,
  })),
);

export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <HashRouter>
          <Suspense fallback={<LoadingPanel label="Loading" />}>
            <Routes>
              {/*
                A share link carries the design itself in the URL, so this route
                renders without the shell and needs no lookup.
              */}
              <Route path="/shared/:token" element={<SharedDesignPage />} />

              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="/readings" element={<ReadingsPage />} />
                <Route path="/readings/:id" element={<ReadingDetailPage />} />
                <Route path="/devices" element={<DevicesPage />} />
                <Route path="/import" element={<ImportPage />} />
                <Route path="/studio" element={<StudioPage />} />
                <Route path="/studio/:designId" element={<StudioPage />} />
              </Route>

              <Route path="/404" element={<NotFoundPage />} />
              <Route path="*" element={<Navigate to="/404" replace />} />
            </Routes>
          </Suspense>
        </HashRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
