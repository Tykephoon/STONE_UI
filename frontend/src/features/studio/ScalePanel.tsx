/**
 * Size-reference panel.
 *
 * Dimensions in millimetres are hard to picture. Standing the stone next to a
 * drinks can answers "how big is it?" instantly, in a way a number never does.
 *
 * Objects are grouped into tabs by category, added with a click, and then
 * dragged around the ground plane in the viewport. Every dimension is a real
 * published measurement — the source is in the tooltip.
 */
import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/Feedback';
import { FieldGroup } from '../../components/ui/Form';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { MapPinIcon, PlusIcon } from '../../components/layout/Icons';
import { formatNumber } from '../../lib/format';
import {
  CATEGORIES,
  REFERENCE_OBJECTS,
  type PlacedReference,
  type ReferenceObject,
  referenceById,
} from './referenceObjects';
import styles from './ScalePanel.module.css';

export interface ScalePanelProps {
  placed: PlacedReference[];
  onAdd: (object: ReferenceObject) => void;
  onRemove: (instanceId: string) => void;
  onClear: () => void;
  selectedInstanceId: string | null;
  /** Longest stone dimension in mm, for the "×" size comparison. */
  stoneLongest: number;
}

type Category = (typeof CATEGORIES)[number];

/** Human-readable size for the list, picking the unit that reads best. */
function describeSize(object: ReferenceObject): string {
  const longest = Math.max(object.length, object.width, object.height);

  if (longest >= 1000) {
    return `${formatNumber(longest / 1000, 2)} m`;
  }
  if (object.shape === 'sphere' || object.shape === 'cylinder') {
    return `⌀${formatNumber(object.length, 1)} × ${formatNumber(object.height, 1)} mm`;
  }
  return `${formatNumber(object.length, 0)} × ${formatNumber(object.width, 0)} × ${formatNumber(
    object.height,
    0,
  )} mm`;
}

export function ScalePanel({
  placed,
  onAdd,
  onRemove,
  onClear,
  selectedInstanceId,
  stoneLongest,
}: ScalePanelProps): JSX.Element {
  const [category, setCategory] = useState<Category>('Everyday');

  const visible = useMemo(
    () => REFERENCE_OBJECTS.filter((object) => object.category === category),
    [category],
  );

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        Drop a real object into the scene for scale, then drag it around the ground to line it up
        against the stone.
      </p>

      <SegmentedControl
        label="Reference category"
        size="sm"
        value={category}
        onChange={setCategory}
        options={CATEGORIES.map((entry) => ({ value: entry, label: entry }))}
      />

      <div className={styles.grid}>
        {visible.map((object) => {
          const ratio = stoneLongest / Math.max(object.length, object.width, object.height);

          return (
            <button
              key={object.id}
              type="button"
              className={styles.item}
              onClick={() => onAdd(object)}
              title={object.source}
            >
              <span
                className={styles.swatch}
                style={{ background: object.color }}
                aria-hidden="true"
              />
              <span className={styles.itemText}>
                <span className={styles.itemName}>{object.name}</span>
                <span className={styles.itemSize}>{describeSize(object)}</span>
              </span>
              <span className={styles.ratio} aria-hidden="true">
                {/* How many of this object span the stone's longest axis. */}
                {ratio >= 1
                  ? `${formatNumber(ratio, ratio >= 10 ? 0 : 1)}×`
                  : `1/${formatNumber(1 / ratio, 1)}`}
              </span>
              <span className={styles.addIcon} aria-hidden="true">
                <PlusIcon size={14} />
              </span>
            </button>
          );
        })}
      </div>

      <p className={styles.ratioHint}>
        The figure on the right is how many of that object span the stone's longest axis.
      </p>

      <FieldGroup title={`In the scene (${placed.length})`}>
        {placed.length === 0 ? (
          <EmptyState
            compact
            icon={<MapPinIcon size={18} />}
            title="Nothing placed yet"
            description="Pick an object above to stand it beside the stone."
          />
        ) : (
          <>
            <ul className={styles.placedList}>
              {placed.map((entry) => {
                const object = referenceById(entry.objectId);
                if (!object) return null;

                return (
                  <li key={entry.instanceId}>
                    <div
                      className={[
                        styles.placedItem,
                        entry.instanceId === selectedInstanceId ? styles.placedSelected : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span
                        className={styles.swatch}
                        style={{ background: object.color }}
                        aria-hidden="true"
                      />
                      <span className={styles.placedText}>
                        <span className={styles.itemName}>{object.name}</span>
                        <span className={styles.itemSize}>
                          {formatNumber(entry.x, 0)}, {formatNumber(entry.z, 0)} mm
                        </span>
                      </span>
                      <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => onRemove(entry.instanceId)}
                        aria-label={`Remove ${object.name}`}
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
                );
              })}
            </ul>

            <Button variant="ghost" size="sm" fullWidth onClick={onClear}>
              Clear the scene
            </Button>
          </>
        )}
      </FieldGroup>
    </div>
  );
}
