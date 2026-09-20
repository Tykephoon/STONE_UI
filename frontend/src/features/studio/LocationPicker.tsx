/**
 * Choosing where a stone comes from.
 *
 * Three things happen here, in the order a person does them: find the place,
 * look at it, then take the ground's measurements.
 *
 *   - **Find it.** Results appear as you type. The geocoder allows one request
 *     a second, so typing is debounced and each new keystroke aborts the
 *     request the last one started; `data/geo.ts` enforces the interval even
 *     if this component ever stops being careful.
 *   - **Look at it.** Aerial imagery over a real elevation model, which can be
 *     tilted into relief and flown around — the keyless equivalent of the
 *     Google Earth view, and the reason there is no map key in this bundle.
 *   - **Measure it.** The elevation under and around the pin is read directly
 *     and summarised, so the stone can be derived from the actual landform
 *     rather than merely seeded by its coordinates.
 *
 * No key exists anywhere in this bundle. The network tab shows OpenStreetMap,
 * Esri, and a public elevation bucket, and nothing else.
 */
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { GeoError, type GroundColour, sampleGroundColour, searchPlaces } from '../../data/geo';
import type { BasemapId } from '../../data/geo';
import {
  type TerrainSample,
  type TerrainSummary,
  fetchTerrain,
  summariseTerrain,
} from '../../data/terrain';
import type { GeoResult } from '../../data/types';
import { LayersIcon, MapPinIcon, MountainIcon, SearchIcon } from '../../components/layout/Icons';
import { LazyMapView } from '../../components/map/LazyMapView';
import { Button } from '../../components/ui/Button';
import { Badge, Spinner } from '../../components/ui/Feedback';
import { formatCoordinate, formatNumber } from '../../lib/format';
import { characteriseTerrain, compassOf, ruggednessOf } from './terrainStone';
import styles from './LocationPicker.module.css';

export interface PickedLocation {
  latitude: number;
  longitude: number;
  label: string | null;
}

/** Everything measured at the pin, handed up so the stone can be built from it. */
export interface TerrainReading {
  sample: TerrainSample;
  summary: TerrainSummary;
  ground: GroundColour | null;
}

export interface LocationPickerProps {
  value: PickedLocation | null;
  onChange: (location: PickedLocation) => void;
  /** Called when the user asks for the stone to be rebuilt from this ground. */
  onShapeFromTerrain?: (reading: TerrainReading) => void;
  height?: number;
}

/**
 * How long to wait after a keystroke before searching.
 *
 * Long enough that typing a word is one request rather than five, short enough
 * that it still feels like the list is keeping up.
 */
const TYPEAHEAD_DELAY_MS = 320;

/** How long the pin must sit still before its ground is read. */
const TERRAIN_DELAY_MS = 550;

export function LocationPicker({
  value,
  onChange,
  onShapeFromTerrain,
  height = 300,
}: LocationPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ latitude: number; longitude: number } | null>(null);

  const [basemap, setBasemap] = useState<BasemapId>('satellite');
  const [showTerrain, setShowTerrain] = useState(true);

  const [reading, setReading] = useState<TerrainReading | null>(null);
  const [terrainState, setTerrainState] = useState<'idle' | 'reading' | 'failed'>('idle');

  /**
   * The one query not to search for: the label just chosen from the list.
   *
   * Without this, picking "Boston" would search for "Boston, Suffolk County,
   * Massachusetts…" and reopen the list under the cursor. It holds the text
   * rather than a bare flag because a chosen label can equal what was already
   * typed, in which case no re-render follows and a flag would never be
   * cleared — suppressing the user's next real keystroke instead.
   */
  const skipQuery = useRef<string | null>(null);

  /* ---- Type-ahead ------------------------------------------------------ */

  useEffect(() => {
    if (skipQuery.current === query) {
      skipQuery.current = null;
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setIsOpen(false);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    setIsSearching(true);

    const timer = setTimeout(async () => {
      try {
        const response = await searchPlaces(trimmed, controller.signal);
        if (controller.signal.aborted) return;

        setResults(response.results);
        setHighlighted(response.results.length > 0 ? 0 : -1);
        setIsOpen(true);
        setSearchError(response.results.length === 0 ? 'No places matched that search.' : null);
      } catch (cause) {
        // An abort means the user typed on. That is not a failure, and showing
        // it as one would make the field flicker red while being used.
        if (cause instanceof DOMException && cause.name === 'AbortError') return;

        setResults([]);
        setSearchError(
          cause instanceof GeoError ? cause.message : 'Search is unavailable right now.',
        );
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, TYPEAHEAD_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const selectResult = useCallback(
    (result: GeoResult) => {
      onChange({
        latitude: result.latitude,
        longitude: result.longitude,
        label: result.label,
      });
      setFlyTo({ latitude: result.latitude, longitude: result.longitude });
      setResults([]);
      setIsOpen(false);
      setHighlighted(-1);
      setSearchError(null);
      skipQuery.current = result.label;
      setQuery(result.label);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        return;
      }

      if (!isOpen || results.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % results.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((index) => (index - 1 + results.length) % results.length);
      } else if (event.key === 'Enter') {
        // Only claim Enter when a row is actually highlighted, so submitting
        // with the list open but nothing chosen still behaves normally.
        const chosen = results[highlighted];
        if (chosen) {
          event.preventDefault();
          selectResult(chosen);
        }
      }
    },
    [highlighted, isOpen, results, selectResult],
  );

  /* ---- Reading the ground ---------------------------------------------- */

  useEffect(() => {
    if (!value) {
      setReading(null);
      setTerrainState('idle');
      return;
    }

    const controller = new AbortController();
    setTerrainState('reading');

    // Dragging the pin fires a change per frame at the end of the gesture.
    // Waiting for it to settle keeps that to one read of the elevation model.
    const timer = setTimeout(async () => {
      try {
        const sample = await fetchTerrain(value.latitude, value.longitude, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        // Best-effort: a missing colour is far less of a loss than a failed
        // read, so the imagery sample never fails the whole operation.
        const ground = await sampleGroundColour(
          value.latitude,
          value.longitude,
          controller.signal,
        );
        if (controller.signal.aborted) return;

        setReading({ sample, summary: summariseTerrain(sample), ground });
        setTerrainState('idle');
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;

        // Elevation is an enhancement, not the feature. The pin, the map, and
        // the coordinate-seeded stone all still work without it, so this
        // reports a missing capability rather than a failure.
        setReading(null);
        setTerrainState('failed');
      }
    }, TERRAIN_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value?.latitude, value?.longitude]);

  const handleMarkerChange = useCallback(
    (position: { latitude: number; longitude: number }) => {
      // Dragging the pin invalidates the place name — the coordinates no
      // longer correspond to the searched result.
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

  const summary = reading?.summary ?? null;
  const ruggedness = reading ? ruggednessOf(reading.summary, reading.sample) : 0;

  return (
    <div className={styles.picker}>
      <div className={styles.searchRow}>
        <div className={styles.searchField}>
          <span className={styles.searchIcon} aria-hidden="true">
            <SearchIcon size={15} />
          </span>
          <input
            type="text"
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => results.length > 0 && setIsOpen(true)}
            // A click lands before blur closes the list, so the list has to
            // outlive the blur by a frame or the click never reaches it.
            onBlur={() => setTimeout(() => setIsOpen(false), 120)}
            placeholder="Search for a place…"
            aria-label="Search for a place"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls="place-results"
            aria-autocomplete="list"
            {...(highlighted >= 0 && isOpen
              ? { 'aria-activedescendant': `place-result-${highlighted}` }
              : {})}
            autoComplete="off"
          />
          {isSearching && (
            <span className={styles.searchSpinner}>
              <Spinner size={14} label="Searching" />
            </span>
          )}

          {isOpen && results.length > 0 && (
            <ul className={styles.results} id="place-results" role="listbox">
              {results.map((result, index) => (
                <li key={`${result.latitude},${result.longitude},${result.label}`} role="presentation">
                  <button
                    type="button"
                    id={`place-result-${index}`}
                    role="option"
                    aria-selected={index === highlighted}
                    className={[
                      styles.resultButton,
                      index === highlighted ? styles.resultActive : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => setHighlighted(index)}
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
        </div>
      </div>

      {searchError && <p className={styles.searchError}>{searchError}</p>}

      <div className={styles.viewRow}>
        <div className={styles.segmented} role="group" aria-label="Basemap">
          <button
            type="button"
            className={basemap === 'satellite' ? styles.segmentOn : styles.segment}
            onClick={() => setBasemap('satellite')}
            aria-pressed={basemap === 'satellite'}
          >
            <LayersIcon size={13} /> Satellite
          </button>
          <button
            type="button"
            className={basemap === 'streets' ? styles.segmentOn : styles.segment}
            onClick={() => setBasemap('streets')}
            aria-pressed={basemap === 'streets'}
          >
            Map
          </button>
        </div>

        <button
          type="button"
          className={showTerrain ? styles.segmentOn : styles.segment}
          onClick={() => setShowTerrain((on) => !on)}
          aria-pressed={showTerrain}
          title="Load the elevation model, then right-drag to tilt"
        >
          <MountainIcon size={13} /> 3D terrain
        </button>
      </div>

      <LazyMapView
        mode="picker"
        height={height}
        marker={value}
        onMarkerChange={handleMarkerChange}
        flyTo={flyTo}
        basemap={basemap}
        terrain={showTerrain}
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
          <div>
            <dt>Elevation</dt>
            <dd>{reading ? `${formatNumber(reading.sample.centreElevation, 0)} m` : '—'}</dd>
          </div>
        </dl>
        <Button size="sm" variant="ghost" onClick={useMyLocation}>
          Use my location
        </Button>
      </div>

      {value?.label && <p className={styles.placeLabel}>{value.label}</p>}

      {terrainState === 'reading' && (
        <p className={styles.terrainStatus}>
          <Spinner size={13} /> Reading the ground…
        </p>
      )}

      {terrainState === 'failed' && (
        <p className={styles.searchError}>
          The elevation model could not be reached, so the stone will be seeded from the
          coordinates alone.
        </p>
      )}

      {summary && reading && (
        <div className={styles.terrain}>
          <div className={styles.terrainHead}>
            <Badge tone="accent">{characteriseTerrain(summary, ruggedness)}</Badge>
            {reading.ground && (
              <span
                className={styles.swatch}
                style={{ background: reading.ground.color }}
                title={`Ground colour ${reading.ground.color}`}
                aria-label={`Ground colour sampled from imagery: ${reading.ground.color}`}
              />
            )}
          </div>

          <dl className={styles.terrainStats}>
            <div>
              <dt>Relief</dt>
              <dd>{formatNumber(summary.relief, 0)} m</dd>
            </div>
            <div>
              <dt>Mean slope</dt>
              <dd>{formatNumber(summary.slopeDegrees, 1)}°</dd>
            </div>
            <div>
              <dt>Roughness</dt>
              <dd>{formatNumber(summary.roughness * 100, 0)}%</dd>
            </div>
            <div>
              <dt>Falls toward</dt>
              <dd>{summary.flat ? '—' : compassOf(summary.aspectDegrees)}</dd>
            </div>
          </dl>

          <p className={styles.terrainNote}>
            Measured across {formatNumber(reading.sample.spanMeters / 1000, 1)} km of real
            elevation data, about {formatNumber(reading.sample.metresPerSample, 0)} m per sample.
          </p>

          {onShapeFromTerrain && (
            <Button
              size="sm"
              variant="secondary"
              fullWidth
              onClick={() => onShapeFromTerrain(reading)}
            >
              Shape the stone from this ground
            </Button>
          )}
        </div>
      )}

      <p className={styles.hint}>
        Click the map or drag the pin to move it. Right-drag tilts the view once terrain is on.
        The coordinates seed the generator, so the same place always produces the same stone — and
        the elevation around the pin decides its proportions and surface.
      </p>
    </div>
  );
}
