/**
 * Shared filter controls for the dashboard and the readings table.
 *
 * Filters sit in one row above the content they affect, and the active set is
 * always visible — a filtered view that looks identical to an unfiltered one is
 * how people end up reading the wrong numbers.
 */
import type { Device } from '../../api/types';
import { type RangePreset, RANGE_PRESETS } from '../../lib/time';
import { SelectField } from '../ui/Form';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SearchIcon } from '../layout/Icons';
import styles from './FilterBar.module.css';

export interface FilterBarProps {
  devices: Device[];
  deviceId: string;
  onDeviceChange: (deviceId: string) => void;
  range: RangePreset;
  onRangeChange: (range: RangePreset) => void;
  /** Omit to hide the search input. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  children?: React.ReactNode;
}

/** Compact labels — the segmented control has to fit on a phone. */
const COMPACT_RANGE_LABELS: Record<RangePreset, string> = {
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All',
};

export function FilterBar({
  devices,
  deviceId,
  onDeviceChange,
  range,
  onRangeChange,
  search,
  onSearchChange,
  searchPlaceholder = 'Search readings…',
  children,
}: FilterBarProps): JSX.Element {
  const deviceOptions = [
    { value: '', label: `All devices (${devices.length})` },
    ...devices.map((device) => ({ value: device.id, label: device.name })),
  ];

  return (
    <div className={styles.bar}>
      <div className={styles.group}>
        <SegmentedControl
          label="Time range"
          size="sm"
          value={range}
          onChange={onRangeChange}
          options={RANGE_PRESETS.map((preset) => ({
            value: preset.value,
            label: COMPACT_RANGE_LABELS[preset.value],
            title: preset.label,
          }))}
        />
      </div>

      <div className={styles.deviceSelect}>
        <SelectField
          label="Device"
          inline
          value={deviceId}
          onChange={(event) => onDeviceChange(event.target.value)}
          options={deviceOptions}
        />
      </div>

      {onSearchChange && (
        <div className={styles.search}>
          <span className={styles.searchIcon} aria-hidden="true">
            <SearchIcon size={15} />
          </span>
          <input
            type="search"
            className={styles.searchInput}
            value={search ?? ''}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search readings"
          />
        </div>
      )}

      {children && <div className={styles.extras}>{children}</div>}
    </div>
  );
}
