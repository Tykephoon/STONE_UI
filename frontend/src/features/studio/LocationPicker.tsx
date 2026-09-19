/**
 * Location input for the generator.
 *
 * Search, the map style, and every tile are proxied by the backend. No map key
 * exists in this bundle, and the network tab shows requests only to the API
 * origin.
 */
import { type FormEvent, useCallback, useState } from 'react';
import { DataError } from '../../data/store';
import { searchPlaces } from '../../data/geo';
import type { GeoResult } from '../../data/types';
import { MapPinIcon, SearchIcon } from '../../components/layout/Icons';
import { LazyMapView } from '../../components/map/LazyMapView';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Feedback';
import { formatCoordinate } from '../../lib/format';
import styles from './LocationPicker.module.css';

export interface PickedLocation {
  latitude: number;
  longitude: number;
  label: string | null;
}

export interface LocationPickerProps {
  value: PickedLocation | null;
  onChange: (location: PickedLocation) => void;
  height?: number;
}

export function LocationPicker({
  value,
  onChange,
  height = 300,
}: LocationPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ latitude: number; longitude: number } | null>(null);

  const runSearch = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        setSearchError('Enter at least two characters.');
        return;
      }

      setIsSearching(true);
      setSearchError(null);
      try {
        const response = await searchPlaces(trimmed);
        setResults(response.results);
        if (response.results.length === 0) {
          setSearchError('No places matched that search.');
        }
      } catch (cause) {
        setResults(null);
        setSearchError(
          cause instanceof DataError ? cause.message : 'Search is unavailable right now.',
        );
      } finally {
        setIsSearching(false);
      }
    },
    [query],
  );

  const selectResult = useCallback(
    (result: GeoResult) => {
      onChange({
        latitude: result.latitude,
        longitude: result.longitude,
        label: result.label,
      });
      setFlyTo({ latitude: result.latitude, longitude: result.longitude });
      setResults(null);
      setQuery(result.label);
    },
    [onChange],
  );

  const handleMarkerChange = useCallback(
    (position: { latitude: number; longitude: number }) => {
      // Dragging the pin invalidates the place name — the coordinates no longer
      // correspond to the searched result.
      onChange({ ...position, label: null });
    },
    [onChange],
  );

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setSearchError('This browser cannot report a location.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const picked = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          label: 'Current location',
        };
        onChange(picked);
        setFlyTo(picked);
      },
      () => setSearchError('Location permission was declined.'),
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [onChange]);

  return (
    <div className={styles.picker}>
      <form className={styles.searchRow} onSubmit={runSearch}>
        <div className={styles.searchField}>
          <span className={styles.searchIcon} aria-hidden="true">
            <SearchIcon size={15} />
          </span>
          <input
            type="search"
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for a place…"
            aria-label="Search for a place"
          />
          {isSearching && (
            <span className={styles.searchSpinner}>
              <Spinner size={14} />
            </span>
          )}
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={isSearching}>
          Search
        </Button>
      </form>

      {searchError && <p className={styles.searchError}>{searchError}</p>}

      {results && results.length > 0 && (
        <ul className={styles.results}>
          {results.map((result) => (
            <li key={`${result.latitude},${result.longitude},${result.label}`}>
              <button
                type="button"
                className={styles.resultButton}
                onClick={() => selectResult(result)}
              >
                <span className={styles.resultIcon} aria-hidden="true">
                  <MapPinIcon size={14} />
                </span>
                <span className={styles.resultText}>
                  {/* Upstream-supplied text, rendered as a text node. */}
                  <span className={styles.resultLabel}>{result.label}</span>
                  <span className={styles.resultCoords}>
                    {formatCoordinate(result.latitude)}, {formatCoordinate(result.longitude)}
                    {result.kind && ` · ${result.kind}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <LazyMapView
        mode="picker"
        height={height}
        marker={value}
        onMarkerChange={handleMarkerChange}
        flyTo={flyTo}
        {...(value ? { initialCenter: [value.longitude, value.latitude] as [number, number] } : {})}
        initialZoom={13}
      />

      <div className={styles.footer}>
        <dl className={styles.coords}>
          <div>
            <dt>Latitude</dt>
            <dd>{value ? formatCoordinate(value.latitude) : '—'}</dd>
          </div>
          <div>
            <dt>Longitude</dt>
            <dd>{value ? formatCoordinate(value.longitude) : '—'}</dd>
          </div>
        </dl>
        <Button size="sm" variant="ghost" onClick={useMyLocation}>
          Use my location
        </Button>
      </div>

      {value?.label && <p className={styles.placeLabel}>{value.label}</p>}

      <p className={styles.hint}>
        Click the map or drag the pin to move it. The coordinates seed the generator, so the same
        place always produces the same stone.
      </p>
    </div>
  );
}
