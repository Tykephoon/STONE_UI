/**
 * Viewer for a shared design.
 *
 * A permalink to one design, rendered without the app shell. The API returns
 * that design's parameters and nothing else — no internal id, no sibling
 * designs, no telemetry — and the link is revocable by whoever minted it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { getSharedDesign } from '../../api/designs';
import type { DesignParams } from '../../api/types';
import { Logo } from '../../components/layout/Logo';
import { DownloadIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { ErrorState, LoadingPanel, Spinner } from '../../components/ui/Feedback';
import { Toggle } from '../../components/ui/Form';
import { formatCount } from '../../lib/format';
import { formatRelative } from '../../lib/time';
import { StoneViewer } from './StoneViewer';
import { encodeParams, exportGltf, exportObj } from './exporters';
import { sanitiseParams } from './types';
import { useStoneGeometry } from './useStoneGeometry';
import styles from './SharedDesignPage.module.css';

export function SharedDesignPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();

  const [params, setParams] = useState<DesignParams | null>(null);
  const [name, setName] = useState('Shared stone');
  const [placeLabel, setPlaceLabel] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [autoRotate, setAutoRotate] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!token) return;

    let active = true;
    const controller = new AbortController();

    getSharedDesign(token, controller.signal)
      .then((response) => {
        if (!active) return;
        // Sanitised because these parameters arrive from a link; a malformed or
        // tampered payload must produce a valid stone rather than a crash.
        setParams(sanitiseParams(response.design.params));
        setName(response.design.name);
        setPlaceLabel(response.design.place_label);
        setUpdatedAt(response.design.updated_at);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError('internal_error', 'This design could not be loaded.', 0),
        );
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [token]);

  const { geometry, isGenerating, stats } = useStoneGeometry(params);

  const longestDimension = useMemo(
    () =>
      params
        ? Math.max(
            params.dimensions.length_mm,
            params.dimensions.width_mm,
            params.dimensions.height_mm,
          )
        : 100,
    [params],
  );

  const handleExport = useCallback(
    async (format: 'glb' | 'obj') => {
      if (!geometry || !params) return;
      setIsExporting(true);
      try {
        if (format === 'glb') {
          await exportGltf(geometry, params, name);
        } else {
          exportObj(geometry, params, name);
        }
      } finally {
        setIsExporting(false);
      }
    },
    [geometry, params, name],
  );

  if (isLoading) return <LoadingPanel label="Loading shared design" />;

  if (error || !params) {
    return (
      <div className={styles.page}>
        <div className={styles.errorCard}>
          <Logo height={26} />
          <ErrorState error={error} />
          <p className={styles.errorHint}>
            Share links can be revoked by their owner, and a revoked link stops working
            immediately.
          </p>
          <Link to="/">
            <Button variant="secondary">Go to Stone</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link to="/" className={styles.brand}>
          <Logo height={24} />
        </Link>
        <div className={styles.topbarActions}>
          <Link to={`/studio?d=${encodeParams(params, name)}`}>
            <Button size="sm" variant="secondary">
              Open a copy in the studio
            </Button>
          </Link>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.viewerFrame}>
          <StoneViewer
            geometry={geometry}
            material={params.material}
            scaleHint={longestDimension}
            showGrid={showGrid}
            autoRotate={autoRotate}
          />
          {isGenerating && (
            <div className={styles.generating}>
              <Spinner size={14} />
              <span>Generating…</span>
            </div>
          )}
        </div>

        <aside className={styles.details}>
          <div>
            {/* Author-supplied text, rendered as a text node. */}
            <h1 className={styles.title}>{name}</h1>
            <p className={styles.subtitle}>
              Shared design
              {updatedAt && ` · updated ${formatRelative(updatedAt)}`}
            </p>
          </div>

          <dl className={styles.specs}>
            <div>
              <dt>Length</dt>
              <dd>{params.dimensions.length_mm} mm</dd>
            </div>
            <div>
              <dt>Width</dt>
              <dd>{params.dimensions.width_mm} mm</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>{params.dimensions.height_mm} mm</dd>
            </div>
            {stats && (
              <div>
                <dt>Mesh</dt>
                <dd>{formatCount(stats.triangles)} triangles</dd>
              </div>
            )}
            {placeLabel && (
              <div className={styles.wide}>
                <dt>Location</dt>
                <dd>{placeLabel}</dd>
              </div>
            )}
          </dl>

          <div className={styles.viewToggles}>
            <Toggle label="Auto-rotate" checked={autoRotate} onChange={setAutoRotate} />
            <Toggle label="Ground grid" checked={showGrid} onChange={setShowGrid} />
          </div>

          <div className={styles.exportRow}>
            <Button
              size="sm"
              variant="secondary"
              disabled={!geometry}
              isLoading={isExporting}
              onClick={() => handleExport('glb')}
              iconLeft={<DownloadIcon size={15} />}
            >
              glTF
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!geometry}
              isLoading={isExporting}
              onClick={() => handleExport('obj')}
              iconLeft={<DownloadIcon size={15} />}
            >
              OBJ
            </Button>
          </div>

          <p className={styles.note}>
            The mesh is generated in your browser from the design's parameters. Drag to orbit,
            scroll to zoom.
          </p>
        </aside>
      </main>
    </div>
  );
}
