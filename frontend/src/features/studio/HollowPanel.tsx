/**
 * Hollow, base, and internal support settings.
 *
 * Everything here changes what gets printed rather than how it looks, so the
 * panel reports consequences in the units a printer cares about — wall
 * thickness in millimetres, cavity volume in millilitres, whether the shape can
 * actually be hollowed at these settings.
 */
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Feedback';
import { FieldGroup, SelectField, Slider, Toggle } from '../../components/ui/Form';
import { PlusIcon } from '../../components/layout/Icons';
import { formatNumber } from '../../lib/format';
import { MAX_WALL_MM, MIN_WALL_MM } from './hollow';
import {
  FIT_PRESETS,
  type FitId,
  SUPPORT_MAX_DIAMETER,
  SUPPORT_MIN_DIAMETER,
  type SupportPost,
} from './baseAndSupports';
import styles from './HollowPanel.module.css';

export interface HollowConfig {
  enabled: boolean;
  wallThickness: number;
  openingHeight: number;
  fit: FitId;
  plugDepth: number;
  supports: SupportPost[];
}

export interface HollowPanelProps {
  config: HollowConfig;
  onChange: (config: HollowConfig) => void;
  /** Null until a shell has been built. */
  report: {
    feasible: boolean;
    cavityVolumeMm3: number;
    pinchedVertices: number;
    shellTriangles: number;
  } | null;
  /** Tallest the opening may sensibly be, from the stone's height. */
  maxOpeningHeight: number;
  onAddSupport: () => void;
  onRemoveSupport: (id: string) => void;
  selectedSupportId: string | null;
}

export function HollowPanel({
  config,
  onChange,
  report,
  maxOpeningHeight,
  onAddSupport,
  onRemoveSupport,
  selectedSupportId,
}: HollowPanelProps): JSX.Element {
  const patch = (changes: Partial<HollowConfig>) => onChange({ ...config, ...changes });

  const fit = FIT_PRESETS.find((entry) => entry.id === config.fit) ?? FIT_PRESETS[1];

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        Print the stone as a shell with an opening underneath, and a base that clips in — so
        something can be sealed inside.
      </p>

      <Toggle
        label="Hollow the stone"
        checked={config.enabled}
        onChange={(enabled) => patch({ enabled })}
        description="Exports a shell and a separate base instead of one solid."
      />

      {config.enabled && (
        <>
          {report && !report.feasible && (
            <p className={styles.blocked}>
              This shape cannot be hollowed at these settings — the wall leaves no cavity, or the
              opening falls where the cross-section breaks up. Reduce the wall thickness, or move
              the opening. The export falls back to the solid until it can be done cleanly.
            </p>
          )}

          {report?.feasible && (
            <div className={styles.statusRow}>
              <Badge tone="good">Shell closes</Badge>
              <Badge tone="neutral">
                {formatNumber(report.cavityVolumeMm3 / 1000, 1)} ml inside
              </Badge>
              {report.pinchedVertices > 0 && (
                <Badge tone="warning">{report.pinchedVertices} thin spots</Badge>
              )}
            </div>
          )}

          {report?.feasible && report.pinchedVertices > 0 && (
            <p className={styles.note}>
              The wall could not reach full thickness everywhere — the shape is narrower than the
              wall in places, and those areas were pulled back to avoid punching through. Reduce
              the thickness for an even wall.
            </p>
          )}

          <FieldGroup title="Wall">
            <Slider
              label="Thickness"
              value={config.wallThickness}
              min={MIN_WALL_MM}
              max={MAX_WALL_MM}
              step={0.2}
              display={`${formatNumber(config.wallThickness, 1)} mm`}
              onChange={(wallThickness) => patch({ wallThickness })}
            />
            <p className={styles.note}>
              {config.wallThickness < 1.6
                ? 'Thin. Fine for a display piece, fragile if handled.'
                : config.wallThickness > 4
                  ? 'Heavy. Strong, but most of the material saving is gone.'
                  : 'A good general-purpose wall: strong enough to handle, light enough to be worth hollowing.'}
            </p>
          </FieldGroup>

          <FieldGroup title="Opening">
            <Slider
              label="Height of cut"
              value={config.openingHeight}
              min={2}
              max={Math.max(4, maxOpeningHeight)}
              step={1}
              display={`${formatNumber(config.openingHeight, 0)} mm`}
              onChange={(openingHeight) => patch({ openingHeight })}
            />
            <p className={styles.note}>
              How far up the stone is cut. Higher gives a wider opening and more room to reach in;
              lower keeps more of the stone's shape.
            </p>
          </FieldGroup>

          <FieldGroup title="Base fit">
            <SelectField
              label="Clearance"
              inline
              value={config.fit}
              onChange={(event) => patch({ fit: event.target.value as FitId })}
              options={FIT_PRESETS.map((entry) => ({
                value: entry.id,
                label: `${entry.name} · ${entry.clearance} mm`,
              }))}
            />
            <p className={styles.note}>{fit.note}</p>

            <Slider
              label="Plug depth"
              value={config.plugDepth}
              min={3}
              max={20}
              step={1}
              display={`${formatNumber(config.plugDepth, 0)} mm`}
              onChange={(plugDepth) => patch({ plugDepth })}
            />
            <p className={styles.note}>
              How far the base reaches into the cavity. Deeper holds more securely; shallower
              leaves more room inside.
            </p>
          </FieldGroup>

          <FieldGroup title={`Internal supports (${config.supports.length})`}>
            <p className={styles.note}>
              Posts inside the cavity, from the base up to the ceiling. The stone turns
              translucent on this tab so they can be seen and dragged; each one stays inside the
              cavity and stops where the roof does. Useful on a wide, flat-topped stone, where
              the roof would otherwise sag.
            </p>

            {config.supports.length > 0 && (
              <ul className={styles.supportList}>
                {config.supports.map((post, index) => (
                  <li key={post.id}>
                    <div
                      className={[
                        styles.supportItem,
                        post.id === selectedSupportId ? styles.supportSelected : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span className={styles.supportName}>Post {index + 1}</span>
                      <span className={styles.supportMeta}>
                        {formatNumber(post.x, 0)}, {formatNumber(post.z, 0)} mm · ⌀
                        {formatNumber(post.diameter, 1)}
                      </span>
                      <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => onRemoveSupport(post.id)}
                        aria-label={`Remove post ${index + 1}`}
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
                  </li>
                ))}
              </ul>
            )}

            {selectedSupportId && (
              <Slider
                label="Selected post diameter"
                value={
                  config.supports.find((post) => post.id === selectedSupportId)?.diameter ?? 6
                }
                min={SUPPORT_MIN_DIAMETER}
                max={SUPPORT_MAX_DIAMETER}
                step={0.5}
                display={`${formatNumber(
                  config.supports.find((post) => post.id === selectedSupportId)?.diameter ?? 6,
                  1,
                )} mm`}
                onChange={(diameter) =>
                  patch({
                    supports: config.supports.map((post) =>
                      post.id === selectedSupportId ? { ...post, diameter } : post,
                    ),
                  })
                }
              />
            )}

            <Button
              variant="secondary"
              size="sm"
              fullWidth
              onClick={onAddSupport}
              disabled={!report?.feasible}
              iconLeft={<PlusIcon size={15} />}
            >
              Add a post
            </Button>

            {config.supports.length > 0 && (
              <p className={styles.note}>
                Posts are written as separate closed bodies in the same file. Slicers union
                overlapping bodies when they slice, so they fuse into the wall — no boolean
                operation is needed, and each body stays watertight on its own.
              </p>
            )}
          </FieldGroup>
        </>
      )}
    </div>
  );
}
