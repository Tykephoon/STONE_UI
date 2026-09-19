/**
 * The stone studio.
 *
 * Left: location, parameters, and the saved library. Right: the live preview
 * and its toolbar. Generation runs in a worker and is debounced, so dragging a
 * slider updates the mesh without the panel going unresponsive.
 *
 * Designs persist through the backend, so they follow the user across devices.
 * Only parameters are stored — the mesh is regenerated deterministically, which
 * is why a saved design is a few hundred bytes rather than several megabytes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataError } from '../../data/store';
import { createDesign, deleteDesign, getDesign, listDesigns, updateDesign } from '../../data/store';
import type { Design, DesignParams } from '../../data/types';
import { CubeIcon, DownloadIcon, PlusIcon, ShareIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { CopyField } from '../../components/ui/CopyField';
import { Badge, EmptyState, ErrorState, Spinner } from '../../components/ui/Feedback';
import { TextField, Toggle } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useToast } from '../../components/ui/Toast';
import { useAction, useAsync } from '../../hooks/useAsync';
import { useLocalPreference } from '../../hooks/useLocalPreference';
import { formatCount } from '../../lib/format';
import { formatRelative } from '../../lib/time';
import { LocationPicker, type PickedLocation } from './LocationPicker';
import { PrintPanel } from './PrintPanel';
import { ScalePanel } from './ScalePanel';
import { StoneViewer } from './StoneViewer';
import { StudioControls } from './StudioControls';
import {
  type PlacedReference,
  type ReferenceObject,
  suggestPlacement,
} from './referenceObjects';
import { buildStl } from './printing';
import { emptySculpt, isSculpted } from './controlPoints';
import {
  buildParameterLink,
  buildViewerLink,
  decodeParams,
  exportGltf,
  exportObj,
  safeFilename,
  triggerDownload,
} from './exporters';
import { DEFAULT_PARAMS, DIMENSION_LIMITS, sanitiseParams, seedFromCoordinates } from './types';
import { useStoneGeometry } from './useStoneGeometry';
import styles from './StudioPage.module.css';

type PanelTab = 'shape' | 'scale' | 'print' | 'location' | 'library';

type Axis = 'length' | 'width' | 'height';

const AXIS_TO_KEY: Record<Axis, keyof DesignParams['dimensions']> = {
  length: 'length_mm',
  width: 'width_mm',
  height: 'height_mm',
};

export function StudioPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const { designId } = useParams<{ designId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<PanelTab>('shape');
  const [params, setParams] = useState<DesignParams>(DEFAULT_PARAMS);
  const [name, setName] = useState('Untitled stone');
  const [location, setLocation] = useState<PickedLocation | null>({
    latitude: 42.3398,
    longitude: -71.0892,
    label: 'Boston, Massachusetts',
  });
  const [loadedDesign, setLoadedDesign] = useState<Design | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const [references, setReferences] = useState<PlacedReference[]>([]);
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  /** True while a control point is being dragged, so the mesh previews cheaply. */
  const [isSculpting, setIsSculpting] = useState(false);

  const [hintSeen, setHintSeen] = useLocalPreference('studio.hintSeen', false);
  const showHint = !hintSeen;
  const dismissHint = useCallback(() => setHintSeen(true), [setHintSeen]);

  const [showControlPoints, setShowControlPoints] = useLocalPreference(
    'studio.showControlPoints',
    true,
  );
  const [showGrid, setShowGrid] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);

  const [saveOpen, setSaveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Design | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Dimension inputs are held as strings so an intermediate value like "1"
  // while typing "120" does not immediately clamp and fight the user.
  const [dimensionDrafts, setDimensionDrafts] = useState({
    length: String(DEFAULT_PARAMS.dimensions.length_mm),
    width: String(DEFAULT_PARAMS.dimensions.width_mm),
    height: String(DEFAULT_PARAMS.dimensions.height_mm),
  });
  const [dimensionErrors, setDimensionErrors] = useState<Partial<Record<Axis, string>>>({});

  const {
    geometry,
    isGenerating,
    error: generateError,
    stats,
  } = useStoneGeometry(params, { interactive: isSculpting });

  const designsState = useAsync((signal) => listDesigns(signal), []);
  const designs = designsState.data?.designs ?? [];

  const saveAction = useAction(createDesign);
  const updateActionState = useAction(updateDesign);
  const deleteActionState = useAction(deleteDesign);

  /** Apply parameters wholesale — from a preset link, a saved design, or a reset. */
  const applyParams = useCallback((next: DesignParams) => {
    setParams(next);
    setDimensionDrafts({
      length: String(next.dimensions.length_mm),
      width: String(next.dimensions.width_mm),
      height: String(next.dimensions.height_mm),
    });
    setDimensionErrors({});
  }, []);

  /** Load an encoded parameter link, then drop it from the URL. */
  const encoded = searchParams.get('d');
  const handledEncoded = useRef<string | null>(null);

  useEffect(() => {
    if (!encoded || handledEncoded.current === encoded) return;
    handledEncoded.current = encoded;

    const decoded = decodeParams(encoded);
    if (!decoded) {
      toast.error('That link could not be read', 'It may be truncated or from another version.');
    } else {
      applyParams(decoded.params);
      setName(decoded.name);
      setLoadedDesign(null);
      setIsDirty(true);
      toast.info('Loaded from link', 'Save it to keep a copy on your account.');
    }

    const next = new URLSearchParams(searchParams);
    next.delete('d');
    setSearchParams(next, { replace: true });
  }, [encoded, applyParams, searchParams, setSearchParams, toast]);

  /** Load a saved design when the route carries an id. */
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!designId || loadedId.current === designId) return;
    loadedId.current = designId;

    let active = true;
    getDesign(designId)
      .then((response) => {
        if (!active) return;
        const design = response.design;
        applyParams(sanitiseParams(design.params));
        setName(design.name);
        setLoadedDesign(design);
        setIsDirty(false);
        if (design.latitude !== null && design.longitude !== null) {
          setLocation({
            latitude: design.latitude,
            longitude: design.longitude,
            label: design.place_label,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        toast.error(
          'Design not found',
          cause instanceof DataError ? cause.message : 'It may have been deleted.',
        );
        navigate('/studio', { replace: true });
      });

    return () => {
      active = false;
    };
  }, [designId, applyParams, navigate, toast]);

  const handleParamsChange = useCallback((next: DesignParams) => {
    setParams(next);
    setIsDirty(true);
  }, []);

  /** Moving the pin reseeds the generator, which is the whole point of it. */
  const handleLocationChange = useCallback(
    (next: PickedLocation) => {
      setLocation(next);
      setParams((current) => ({
        ...current,
        seed: seedFromCoordinates(next.latitude, next.longitude),
      }));
      setIsDirty(true);
    },
    [],
  );

  const handleDimensionDraft = useCallback((axis: Axis, value: string) => {
    setDimensionDrafts((current) => ({ ...current, [axis]: value }));

    const parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed)) {
      setDimensionErrors((current) => ({ ...current, [axis]: 'Enter a number.' }));
      return;
    }
    if (parsed < DIMENSION_LIMITS.min || parsed > DIMENSION_LIMITS.max) {
      setDimensionErrors((current) => ({
        ...current,
        [axis]: `Between ${DIMENSION_LIMITS.min} and ${DIMENSION_LIMITS.max} mm.`,
      }));
      return;
    }

    setDimensionErrors((current) => {
      const next = { ...current };
      delete next[axis];
      return next;
    });
    setParams((current) => ({
      ...current,
      dimensions: { ...current.dimensions, [AXIS_TO_KEY[axis]]: parsed },
    }));
    setIsDirty(true);
  }, []);

  const handleReset = useCallback(() => {
    applyParams({
      ...DEFAULT_PARAMS,
      seed: location
        ? seedFromCoordinates(location.latitude, location.longitude)
        : DEFAULT_PARAMS.seed,
    });
    setResetSignal((value) => value + 1);
    setIsDirty(true);
    toast.info('Parameters reset');
  }, [applyParams, location, toast]);

  const designPayload = useMemo(
    () => ({
      name: name.trim() || 'Untitled stone',
      params,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      place_label: location?.label ?? null,
    }),
    [name, params, location],
  );

  const handleSaveNew = useCallback(async () => {
    const result = await saveAction.run(designPayload);
    if (result.ok) {
      setLoadedDesign(result.data.design);
      setIsDirty(false);
      setSaveOpen(false);
      loadedId.current = result.data.design.id;
      designsState.reload();
      navigate(`/studio/${result.data.design.id}`, { replace: true });
      toast.success('Design saved', 'It is now available on any device you sign in from.');
    }
  }, [saveAction, designPayload, designsState, navigate, toast]);

  const handleUpdate = useCallback(async () => {
    if (!loadedDesign) return;
    const result = await updateActionState.run(loadedDesign.id, designPayload);
    if (result.ok) {
      setLoadedDesign(result.data.design);
      setIsDirty(false);
      designsState.reload();
      toast.success('Design updated');
    }
  }, [loadedDesign, updateActionState, designPayload, designsState, toast]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const result = await deleteActionState.run(deleteTarget.id);
    if (result.ok) {
      const wasOpen = loadedDesign?.id === deleteTarget.id;
      setDeleteTarget(null);
      designsState.reload();
      if (wasOpen) {
        setLoadedDesign(null);
        loadedId.current = null;
        navigate('/studio', { replace: true });
      }
      toast.success('Design deleted');
    }
  }, [deleteTarget, deleteActionState, designsState, loadedDesign, navigate, toast]);

  const addReference = useCallback(
    (object: ReferenceObject) => {
      setReferences((current) => {
        const spot = suggestPlacement(current, params.dimensions.length_mm, object);
        return [
          ...current,
          {
            instanceId: `${object.id}-${Date.now().toString(36)}`,
            objectId: object.id,
            x: spot.x,
            z: spot.z,
          },
        ];
      });
    },
    [params.dimensions.length_mm],
  );

  const removeReference = useCallback((instanceId: string) => {
    setReferences((current) => current.filter((entry) => entry.instanceId !== instanceId));
    setSelectedReference((current) => (current === instanceId ? null : current));
  }, []);

  const moveReference = useCallback((instanceId: string, x: number, z: number) => {
    setReferences((current) =>
      current.map((entry) => (entry.instanceId === instanceId ? { ...entry, x, z } : entry)),
    );
  }, []);

  /** Live pull updates while a control point is dragged. */
  const previewSculpt = useCallback((pulls: number[]) => {
    setIsSculpting(true);
    setParams((current) => ({
      ...current,
      sculpt: { ...(current.sculpt ?? emptySculpt()), pulls },
    }));
  }, []);

  /** Drag finished: drop back to full resolution and mark the design dirty. */
  const commitSculpt = useCallback((pulls: number[]) => {
    setIsSculpting(false);
    setParams((current) => ({
      ...current,
      sculpt: { ...(current.sculpt ?? emptySculpt()), pulls },
    }));
    setIsDirty(true);
  }, []);

  const setInfluence = useCallback((influence: number) => {
    setParams((current) => ({
      ...current,
      sculpt: { ...(current.sculpt ?? emptySculpt()), influence },
    }));
    setIsDirty(true);
  }, []);

  const clearSculpt = useCallback(() => {
    setParams((current) => ({ ...current, sculpt: emptySculpt() }));
    setIsDirty(true);
    toast.info('Sculpting cleared');
  }, [toast]);

  const handleExportStl = useCallback(() => {
    if (!geometry) return;
    setIsExporting(true);
    try {
      triggerDownload(
        new Blob([buildStl(geometry, name)], { type: 'model/stl' }),
        safeFilename(name, 'stl'),
      );
      toast.success('STL exported', 'Open it in your slicer at 100% scale.');
    } catch {
      toast.error('Export failed', 'Try a lower mesh resolution.');
    } finally {
      setIsExporting(false);
    }
  }, [geometry, name, toast]);

  const handleExport = useCallback(
    async (format: 'glb' | 'obj') => {
      if (!geometry) return;
      setIsExporting(true);
      try {
        if (format === 'glb') {
          await exportGltf(geometry, params, name);
        } else {
          exportObj(geometry, params, name);
        }
        toast.success(`${format.toUpperCase()} exported`);
      } catch {
        toast.error('Export failed', 'Try a lower mesh resolution.');
      } finally {
        setIsExporting(false);
      }
    },
    [geometry, params, name, toast],
  );

  const longestDimension = Math.max(
    params.dimensions.length_mm,
    params.dimensions.width_mm,
    params.dimensions.height_mm,
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Studio</h1>
          <p className={styles.subtitle}>
            {loadedDesign ? (
              <>
                Editing <strong>{loadedDesign.name}</strong>
                {isDirty && <Badge tone="warning">Unsaved changes</Badge>}
              </>
            ) : (
              'Pick a location, shape the stone, then save or export it.'
            )}
          </p>
        </div>

        <div className={styles.headerActions}>
          {loadedDesign && (
            <Button
              variant="secondary"
              onClick={handleUpdate}
              isLoading={updateActionState.isPending}
              disabled={!isDirty}
            >
              Save
            </Button>
          )}
          <Button
            variant={loadedDesign ? 'ghost' : 'primary'}
            onClick={() => setSaveOpen(true)}
            iconLeft={<PlusIcon size={15} />}
          >
            {loadedDesign ? 'Save as new' : 'Save design'}
          </Button>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.panel}>
          <SegmentedControl
            label="Editor panel"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'shape', label: 'Shape' },
              { value: 'scale', label: 'Scale' },
              { value: 'print', label: 'Print' },
              { value: 'location', label: 'Place' },
              { value: 'library', label: 'Saved' },
            ]}
          />

          <div className={styles.panelBody}>
            {tab === 'location' && (
              <LocationPicker value={location} onChange={handleLocationChange} height={260} />
            )}

            {tab === 'shape' && (
              <StudioControls
                params={params}
                onChange={handleParamsChange}
                onReset={handleReset}
                dimensionDrafts={dimensionDrafts}
                onDimensionDraftChange={handleDimensionDraft}
                dimensionErrors={dimensionErrors}
                onInfluenceChange={setInfluence}
                onClearSculpt={clearSculpt}
                hasSculpt={isSculpted(params.sculpt ?? emptySculpt())}
                showControlPoints={showControlPoints}
                onShowControlPointsChange={setShowControlPoints}
              />
            )}

            {tab === 'scale' && (
              <ScalePanel
                placed={references}
                onAdd={addReference}
                onRemove={removeReference}
                onClear={() => {
                  setReferences([]);
                  setSelectedReference(null);
                }}
                selectedInstanceId={selectedReference}
                stoneLongest={longestDimension}
              />
            )}

            {tab === 'print' && (
              <PrintPanel
                geometry={geometry}
                onExportStl={handleExportStl}
                onExportGltf={() => handleExport('glb')}
                onExportObj={() => handleExport('obj')}
                isExporting={isExporting}
              />
            )}

            {tab === 'library' && (
              <div className={styles.library}>
                {designsState.error ? (
                  <ErrorState error={designsState.error} onRetry={designsState.reload} compact />
                ) : designsState.isLoading ? (
                  <div className={styles.libraryLoading}>
                    <Spinner size={18} />
                  </div>
                ) : designs.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<CubeIcon size={20} />}
                    title="No saved designs"
                    description="Save a stone and it will appear here on every device you sign in from."
                  />
                ) : (
                  <ul className={styles.designList}>
                    {designs.map((design) => (
                      <li key={design.id}>
                        <div
                          className={[
                            styles.designItem,
                            loadedDesign?.id === design.id ? styles.designItemActive : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <button
                            type="button"
                            className={styles.designOpen}
                            onClick={() => {
                              loadedId.current = null;
                              navigate(`/studio/${design.id}`);
                            }}
                          >
                            <span
                              className={styles.designSwatch}
                              style={{
                                background: `linear-gradient(135deg, ${design.params.material.color}, ${design.params.material.accentColor})`,
                              }}
                              aria-hidden="true"
                            />
                            <span className={styles.designText}>
                              <span className={styles.designName}>{design.name}</span>
                              <span className={styles.designMeta}>
                                {Math.round(design.params.dimensions.length_mm)} ×{' '}
                                {Math.round(design.params.dimensions.width_mm)} ×{' '}
                                {Math.round(design.params.dimensions.height_mm)} mm ·{' '}
                                {formatRelative(design.updated_at)}
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={styles.designDelete}
                            onClick={() => setDeleteTarget(design)}
                            aria-label={`Delete ${design.name}`}
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                              <path
                                d="M4 4l8 8M12 4l-8 8"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                              />
                            </svg>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>

        <section className={styles.viewerColumn}>
          <div className={styles.viewerFrame}>
            <StoneViewer
              geometry={geometry}
              material={params.material}
              dimensions={params.dimensions}
              sculpt={params.sculpt ?? emptySculpt()}
              references={references}
              editable
              showControlPoints={showControlPoints}
              showGrid={showGrid}
              autoRotate={autoRotate}
              resetSignal={resetSignal}
              onSculptPreview={previewSculpt}
              onSculptCommit={commitSculpt}
              onReferenceMoved={moveReference}
              onReferenceSelected={setSelectedReference}
            />

            {isGenerating && (
              <div className={styles.generating}>
                <Spinner size={14} />
                <span>Generating…</span>
              </div>
            )}

            {showHint && geometry && (
              <div className={styles.hint} role="note">
                <span className={styles.hintAxes} aria-hidden="true">
                  <span style={{ background: '#e05252' }} />
                  <span style={{ background: '#c9c3b6' }} />
                  <span style={{ background: '#4caf50' }} />
                </span>
                <span className={styles.hintText}>
                  Drag the dots on the surface to pull the rock out or push it in. Add objects
                  from the <strong>Scale</strong> tab and drag them to compare sizes.
                </span>
                <button
                  type="button"
                  className={styles.hintDismiss}
                  onClick={dismissHint}
                  aria-label="Dismiss hint"
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            )}

            {generateError && (
              <div className={styles.viewerError} role="alert">
                {generateError}
              </div>
            )}
          </div>

          <div className={styles.viewerBar}>
            <div className={styles.viewerStats}>
              <span>
                {Math.round(params.dimensions.length_mm)} ×{' '}
                {Math.round(params.dimensions.width_mm)} ×{' '}
                {Math.round(params.dimensions.height_mm)} mm
              </span>
              {isSculpting && <span className={styles.liveDimensions}>sculpting</span>}
              {stats && (
                <>
                  <span className={styles.separator}>·</span>
                  <span>{formatCount(stats.triangles)} triangles</span>
                  <span className={styles.separator}>·</span>
                  <span>{stats.durationMs.toFixed(0)} ms</span>
                </>
              )}
            </div>

            <div className={styles.viewerControls}>
              <Toggle
                label="Handles"
                checked={showControlPoints}
                onChange={setShowControlPoints}
              />
              <Toggle label="Grid" checked={showGrid} onChange={setShowGrid} />
              <Toggle label="Rotate" checked={autoRotate} onChange={setAutoRotate} />
              <Button size="sm" variant="ghost" onClick={() => setResetSignal((v) => v + 1)}>
                Recentre
              </Button>
            </div>
          </div>

          <div className={styles.exportBar}>
            <Button
              size="sm"
              variant="secondary"
              disabled={!geometry}
              isLoading={isExporting}
              onClick={() => handleExport('glb')}
              iconLeft={<DownloadIcon size={15} />}
            >
              glTF (.glb)
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
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShareOpen(true)}
              iconLeft={<ShareIcon size={15} />}
            >
              Share
            </Button>
          </div>
        </section>
      </div>

      {/* ---- save ---- */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save design"
        description="Stored on your account, so it follows you across devices."
        busy={saveAction.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveNew}
              isLoading={saveAction.isPending}
              disabled={!name.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        {saveAction.error && <ErrorState error={saveAction.error} compact />}
        <TextField
          label="Name"
          required
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          hint="Only the parameters are stored — the mesh is regenerated from them."
        />
      </Modal>

      {/* ---- share ---- */}
      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title="Share this stone"
        size="md"
        footer={
          <Button variant="ghost" onClick={() => setShareOpen(false)}>
            Done
          </Button>
        }
      >
        <div className={styles.shareBody}>
          <section>
            <h3 className={styles.shareHeading}>Editable link</h3>
            <p className={styles.shareText}>
              The whole design encoded in the URL. Opening it loads these parameters into the
              studio, ready to change. No server is involved — the recipient's browser regenerates
              the identical stone from the link alone.
            </p>
            <CopyField value={buildParameterLink(params, name)} />
          </section>

          <section>
            <h3 className={styles.shareHeading}>Read-only link</h3>
            <p className={styles.shareText}>
              The same design as a viewer page: orbit, zoom, and export, without the editing
              controls. Useful for showing someone the result rather than the recipe.
            </p>
            <CopyField value={buildViewerLink(params, name)} />
          </section>

          <p className={styles.shareNote}>
            Both links carry the design itself, so they keep working forever and cannot be
            revoked. Anyone you send one to can read it — do not treat a link as private.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete this design?"
        description={
          <>
            <strong>{deleteTarget?.name}</strong> will be removed permanently, along with any share
            links pointing at it.
          </>
        }
        confirmLabel="Delete"
        destructive
        isPending={deleteActionState.isPending}
      />
    </div>
  );
}
