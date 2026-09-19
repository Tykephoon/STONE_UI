/**
 * Read-only viewer for a shared design.
 *
 * The design travels in the URL rather than being fetched: the route parameter
 * *is* the encoded parameter set. That means a link works with no server, no
 * account, and no expiry — and, equally, that it cannot be revoked. The page
 * says so rather than implying a privacy it cannot provide.
 *
 * Parameters are sanitised before they reach the generator, because this input
 * arrives from a URL a stranger may have edited.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CubeIcon, DownloadIcon } from '../../components/layout/Icons';
import { Logo } from '../../components/layout/Logo';
import { Button } from '../../components/ui/Button';
import { EmptyState, Spinner } from '../../components/ui/Feedback';
import { Toggle } from '../../components/ui/Form';
import { formatCount } from '../../lib/format';
import { StoneViewer } from './StoneViewer';
import { decodeParams, exportGltf, exportObj } from './exporters';
import { useStoneGeometry } from './useStoneGeometry';
import styles from './SharedDesignPage.module.css';

export function SharedDesignPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();

  // Decoding is synchronous and cheap, so there is no loading state to manage.
  const decoded = useMemo(() => (token ? decodeParams(token) : null), [token]);

  const [autoRotate, setAutoRotate] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const params = decoded?.params ?? null;
  const name = decoded?.name ?? 'Shared stone';

  const { geometry, isGenerating, stats } = useStoneGeometry(params);

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

  if (!params) {
    return (
      <div className={styles.page}>
        <div className={styles.errorCard}>
          <Logo height={26} />
          <EmptyState
            icon={<CubeIcon size={22} />}
            title="This link could not be read"
            description="It may have been truncated in transit, or created by a different version of the app. Ask for a fresh link."
          />
          <Link to="/studio">
            <Button variant="secondary">Open the studio</Button>
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
          <Link to={`/studio?d=${token ?? ''}`}>
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
            dimensions={params.dimensions}
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
            <p className={styles.subtitle}>Shared design</p>
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
            The mesh is generated in your browser from the parameters in this link — nothing is
            downloaded from a server. Drag to orbit, scroll to zoom.
          </p>
        </aside>
      </main>
    </div>
  );
}
