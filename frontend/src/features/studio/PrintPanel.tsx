/**
 * 3D-printing panel.
 *
 * Shows what a slicer will make of the model before it is exported, because
 * discovering a problem after a nine-hour print is the expensive way to find
 * out. The watertight check is the one that matters: a mesh with open edges is
 * either silently "repaired" into something you did not design, or rejected.
 */
import { useMemo, useState } from 'react';
import type { BufferGeometry } from 'three';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Feedback';
import { FieldGroup, SelectField, Slider } from '../../components/ui/Form';
import { DownloadIcon } from '../../components/layout/Icons';
import { formatCount, formatNumber } from '../../lib/format';
import { MATERIALS, type MaterialId, computePrintStats, estimateMass } from './printing';
import styles from './PrintPanel.module.css';

export interface PrintPanelProps {
  geometry: BufferGeometry | null;
  /** True when the Hollow tab is exporting a shell and base instead of a solid. */
  hollowEnabled?: boolean;
  /** False when the shape could not be hollowed and the export falls back. */
  hollowFeasible?: boolean;
  onExportStl: () => void;
  onExportGltf: () => void;
  onExportObj: () => void;
  isExporting: boolean;
}

/** Build volumes of common printers, to flag a model that will not fit. */
const PRINTERS = [
  { id: 'a1mini', name: 'Bambu A1 mini', x: 180, y: 180, z: 180 },
  { id: 'p1s', name: 'Bambu P1S / X1C', x: 256, y: 256, z: 256 },
  { id: 'ender3', name: 'Ender 3', x: 220, y: 220, z: 250 },
  { id: 'prusamk4', name: 'Prusa MK4', x: 250, y: 210, z: 220 },
  { id: 'mars4', name: 'Elegoo Mars 4 (resin)', x: 153, y: 77, z: 165 },
  { id: 'none', name: 'No printer selected', x: 0, y: 0, z: 0 },
] as const;

export function PrintPanel({
  geometry,
  hollowEnabled = false,
  hollowFeasible = true,
  onExportStl,
  onExportGltf,
  onExportObj,
  isExporting,
}: PrintPanelProps): JSX.Element {
  const [materialId, setMaterialId] = useState<MaterialId>('pla');
  const [infill, setInfill] = useState(0.15);
  const [printerId, setPrinterId] = useState<string>('p1s');

  // Recomputing walks every triangle, so it is tied to the geometry identity
  // rather than run on each render.
  const stats = useMemo(() => (geometry ? computePrintStats(geometry) : null), [geometry]);

  const material = MATERIALS.find((entry) => entry.id === materialId) ?? MATERIALS[0];
  const printer = PRINTERS.find((entry) => entry.id === printerId);

  const mass = stats ? estimateMass(stats.volumeMm3, material.density, infill) : 0;

  /** A model can fit rotated, so test both footprint orientations. */
  const fit = useMemo(() => {
    if (!stats || !printer || printer.id === 'none') return null;
    const { length, width, height } = stats.boundingBox;

    const fitsUpright =
      (length <= printer.x && width <= printer.y) || (width <= printer.x && length <= printer.y);

    return { fits: fitsUpright && height <= printer.z, tooTall: height > printer.z };
  }, [stats, printer]);

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        STL is exported at true size in millimetres, standing the way it sits on the grid. Slicers
        assume millimetres, so no rescaling is needed on import.
      </p>

      {hollowEnabled && (
        <p className={hollowFeasible ? styles.intro : styles.warning}>
          {hollowFeasible
            ? 'Hollow is on: this exports two files — the shell, and the base that clips into it. The figures below still describe the solid.'
            : 'Hollow is on, but this shape cannot be hollowed at its current settings, so the export falls back to a solid. See the Hollow tab.'}
        </p>
      )}

      {stats && (
        <>
          <div className={styles.statusRow}>
            {stats.isWatertight ? (
              <Badge tone="good">Watertight</Badge>
            ) : (
              <Badge tone="critical">{formatCount(stats.openEdgeCount)} open edges</Badge>
            )}
            <Badge tone="neutral">{formatCount(stats.triangleCount)} triangles</Badge>
            {fit && (fit.fits ? <Badge tone="good">Fits</Badge> : <Badge tone="warning">Too large</Badge>)}
          </div>

          {!stats.isWatertight && (
            <p className={styles.warning}>
              This mesh has holes, so a slicer cannot reliably tell inside from outside. Lower the
              faceting or raise the resolution and check again.
            </p>
          )}

          <FieldGroup title="Model">
            <dl className={styles.stats}>
              <div>
                <dt>Bounding box</dt>
                <dd>
                  {formatNumber(stats.boundingBox.length, 1)} ×{' '}
                  {formatNumber(stats.boundingBox.width, 1)} ×{' '}
                  {formatNumber(stats.boundingBox.height, 1)} mm
                </dd>
              </div>
              <div>
                <dt>Solid volume</dt>
                <dd>{formatNumber(stats.volumeMm3 / 1000, 1)} cm³</dd>
              </div>
              <div>
                <dt>Surface area</dt>
                <dd>{formatNumber(stats.surfaceAreaMm2 / 100, 1)} cm²</dd>
              </div>
            </dl>
          </FieldGroup>

          <FieldGroup title="Material estimate">
            <SelectField
              label="Material"
              inline
              value={materialId}
              onChange={(event) => setMaterialId(event.target.value as MaterialId)}
              options={MATERIALS.map((entry) => ({
                value: entry.id,
                label: `${entry.name} · ${entry.density} g/cm³`,
              }))}
            />

            <Slider
              label="Infill"
              value={infill}
              min={0}
              max={1}
              step={0.05}
              display={`${Math.round(infill * 100)}%`}
              onChange={setInfill}
            />

            <dl className={styles.stats}>
              <div>
                <dt>Estimated mass</dt>
                <dd className={styles.headline}>{formatNumber(mass, 1)} g</dd>
              </div>
              <div>
                <dt>Filament length</dt>
                {/* 1.75 mm filament has a cross-section of ~2.405 mm². */}
                <dd>{formatNumber(mass / material.density / 2.405 / 10, 1)} m</dd>
              </div>
            </dl>

            <p className={styles.note}>
              An estimate only. The shell prints solid regardless of infill, so this assumes about
              a quarter of the volume is perimeter and skin. Your slicer's figure is the real one.
            </p>
          </FieldGroup>

          <FieldGroup title="Printer">
            <SelectField
              label="Build volume"
              inline
              value={printerId}
              onChange={(event) => setPrinterId(event.target.value)}
              options={PRINTERS.map((entry) => ({
                value: entry.id,
                label:
                  entry.id === 'none' ? entry.name : `${entry.name} · ${entry.x}×${entry.y}×${entry.z}`,
              }))}
            />

            {fit && !fit.fits && (
              <p className={styles.warning}>
                {fit.tooTall
                  ? 'Taller than the build volume. Reduce the height, or split the model in your slicer.'
                  : 'Wider than the build plate in both orientations. Reduce the length or width.'}
              </p>
            )}
          </FieldGroup>
        </>
      )}

      <FieldGroup title="Export">
        <Button
          variant="primary"
          fullWidth
          disabled={!geometry}
          isLoading={isExporting}
          onClick={onExportStl}
          iconLeft={<DownloadIcon size={15} />}
        >
          {hollowEnabled && hollowFeasible ? 'STL — shell and base' : 'STL for printing'}
        </Button>

        <div className={styles.secondaryExports}>
          <Button
            size="sm"
            variant="secondary"
            disabled={!geometry}
            isLoading={isExporting}
            onClick={onExportGltf}
          >
            glTF
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!geometry}
            isLoading={isExporting}
            onClick={onExportObj}
          >
            OBJ
          </Button>
        </div>

        <p className={styles.note}>
          STL carries geometry only — no colour. glTF keeps the vertex colours for rendering; OBJ
          is the lowest common denominator for other CAD tools.
        </p>
      </FieldGroup>
    </div>
  );
}
