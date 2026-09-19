/**
 * Parameter panel.
 *
 * Grouped by what the control does to the object rather than by data type:
 * size, then overall form, then surface character, then material. Every change
 * is applied immediately — there is no Apply button, because the preview is the
 * feedback.
 */
import type { DesignParams } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { ColorField, FieldGroup, Slider, TextField } from '../../components/ui/Form';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { formatCount } from '../../lib/format';
import { PRESETS, RESOLUTION_LIMITS, trianglesForResolution } from './types';
import styles from './StudioControls.module.css';

export interface StudioControlsProps {
  params: DesignParams;
  onChange: (params: DesignParams) => void;
  onReset: () => void;
  /** Millimetre dimensions as raw strings, so a half-typed number is editable. */
  dimensionDrafts: { length: string; width: string; height: string };
  onDimensionDraftChange: (axis: 'length' | 'width' | 'height', value: string) => void;
  dimensionErrors: Partial<Record<'length' | 'width' | 'height', string>>;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export function StudioControls({
  params,
  onChange,
  onReset,
  dimensionDrafts,
  onDimensionDraftChange,
  dimensionErrors,
}: StudioControlsProps): JSX.Element {
  const patch = <K extends keyof DesignParams>(key: K, value: Partial<DesignParams[K]>) => {
    onChange({
      ...params,
      [key]: { ...(params[key] as object), ...value } as DesignParams[K],
    });
  };

  const applyPreset = (presetId: string) => {
    const preset = PRESETS.find((entry) => entry.id === presetId);
    if (!preset) return;
    // Size and seed belong to the user's intent; a preset changes character.
    onChange({
      ...params,
      form: preset.patch.form,
      surface: { ...preset.patch.surface, resolution: params.surface.resolution },
      material: preset.patch.material,
    });
  };

  return (
    <div className={styles.panel}>
      <FieldGroup title="Presets">
        <div className={styles.presets}>
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={styles.preset}
              onClick={() => applyPreset(preset.id)}
              title={preset.description}
            >
              <span
                className={styles.presetSwatch}
                style={{
                  background: `linear-gradient(135deg, ${preset.patch.material.color}, ${preset.patch.material.accentColor})`,
                }}
                aria-hidden="true"
              />
              <span className={styles.presetName}>{preset.name}</span>
            </button>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup title="Dimensions (mm)">
        <div className={styles.dimensions}>
          <TextField
            label="Length"
            type="number"
            inputMode="decimal"
            min={1}
            max={10000}
            step={1}
            value={dimensionDrafts.length}
            error={dimensionErrors.length}
            onChange={(event) => onDimensionDraftChange('length', event.target.value)}
          />
          <TextField
            label="Width"
            type="number"
            inputMode="decimal"
            min={1}
            max={10000}
            step={1}
            value={dimensionDrafts.width}
            error={dimensionErrors.width}
            onChange={(event) => onDimensionDraftChange('width', event.target.value)}
          />
          <TextField
            label="Height"
            type="number"
            inputMode="decimal"
            min={1}
            max={10000}
            step={1}
            value={dimensionDrafts.height}
            error={dimensionErrors.height}
            onChange={(event) => onDimensionDraftChange('height', event.target.value)}
          />
        </div>
        <p className={styles.note}>
          The generated mesh is scaled so its bounding box matches these values exactly.
        </p>
      </FieldGroup>

      <FieldGroup title="Form">
        <Slider
          label="Roundness"
          value={params.form.roundness}
          min={0}
          max={1}
          display={percent(params.form.roundness)}
          onChange={(value) => patch('form', { roundness: value })}
        />
        <Slider
          label="Taper"
          value={params.form.taper}
          min={-1}
          max={1}
          display={
            params.form.taper === 0
              ? 'even'
              : params.form.taper > 0
                ? `${percent(params.form.taper)} up`
                : `${percent(-params.form.taper)} down`
          }
          onChange={(value) => patch('form', { taper: value })}
        />
        <Slider
          label="Asymmetry"
          value={params.form.asymmetry}
          min={0}
          max={1}
          display={percent(params.form.asymmetry)}
          onChange={(value) => patch('form', { asymmetry: value })}
        />
        <Slider
          label="Flatten"
          value={params.form.flatten}
          min={0}
          max={1}
          display={percent(params.form.flatten)}
          onChange={(value) => patch('form', { flatten: value })}
        />
        <Slider
          label="Bulge"
          value={params.form.bulge}
          min={0}
          max={1}
          display={percent(params.form.bulge)}
          onChange={(value) => patch('form', { bulge: value })}
        />
      </FieldGroup>

      <FieldGroup title="Surface">
        <Slider
          label="Detail"
          value={params.surface.detail}
          min={0}
          max={1}
          display={percent(params.surface.detail)}
          onChange={(value) => patch('surface', { detail: value })}
        />
        <Slider
          label="Grain"
          value={params.surface.grain}
          min={0}
          max={1}
          display={percent(params.surface.grain)}
          onChange={(value) => patch('surface', { grain: value })}
        />
        <Slider
          label="Erosion"
          value={params.surface.erosion}
          min={0}
          max={1}
          display={percent(params.surface.erosion)}
          onChange={(value) => patch('surface', { erosion: value })}
        />
        <Slider
          label="Faceting"
          value={params.surface.faceting}
          min={0}
          max={1}
          display={percent(params.surface.faceting)}
          onChange={(value) => patch('surface', { faceting: value })}
        />

        <div className={styles.resolution}>
          <div className={styles.resolutionHead}>
            <span className={styles.resolutionLabel}>Mesh resolution</span>
            <span className={styles.resolutionValue}>
              ~{formatCount(trianglesForResolution(params.surface.resolution))} triangles
            </span>
          </div>
          <SegmentedControl
            label="Mesh resolution"
            size="sm"
            value={String(params.surface.resolution)}
            onChange={(value) => patch('surface', { resolution: Number(value) })}
            options={Array.from(
              { length: RESOLUTION_LIMITS.max - RESOLUTION_LIMITS.min + 1 },
              (_, index) => {
                const level = RESOLUTION_LIMITS.min + index;
                return {
                  value: String(level),
                  label: String(level),
                  title: `Level ${level} · ~${trianglesForResolution(level).toLocaleString()} triangles`,
                };
              },
            )}
          />
          <p className={styles.note}>
            Higher levels resolve finer surface detail and cost more to generate and export.
          </p>
        </div>
      </FieldGroup>

      <FieldGroup title="Material">
        <ColorField
          label="Base colour"
          value={params.material.color}
          onChange={(value) => patch('material', { color: value })}
        />
        <ColorField
          label="Mineral accent"
          value={params.material.accentColor}
          onChange={(value) => patch('material', { accentColor: value })}
        />
        <Slider
          label="Speckle"
          value={params.material.speckle}
          min={0}
          max={1}
          display={percent(params.material.speckle)}
          onChange={(value) => patch('material', { speckle: value })}
        />
        <Slider
          label="Roughness"
          value={params.material.roughness}
          min={0}
          max={1}
          display={percent(params.material.roughness)}
          onChange={(value) => patch('material', { roughness: value })}
        />
        <Slider
          label="Metalness"
          value={params.material.metalness}
          min={0}
          max={1}
          display={percent(params.material.metalness)}
          onChange={(value) => patch('material', { metalness: value })}
        />
        <Slider
          label="Wet sheen"
          value={params.material.clearcoat}
          min={0}
          max={1}
          display={percent(params.material.clearcoat)}
          onChange={(value) => patch('material', { clearcoat: value })}
        />
      </FieldGroup>

      <Button variant="ghost" size="sm" fullWidth onClick={onReset}>
        Reset to defaults
      </Button>
    </div>
  );
}
