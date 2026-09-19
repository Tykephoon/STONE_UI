/**
 * Single-reading entry.
 *
 * For the case where there is no file at all — a value read off a gauge and
 * typed in. Only the timestamp and position are required; every other field is
 * optional and stays null when left blank, which is what the charts expect for
 * a sensor that was not fitted.
 */
import { type FormEvent, useCallback, useState } from 'react';
import { addReadings, createDevice, newId, type ReadingRecord } from '../../data/store';
import type { Device } from '../../data/types';
import { PlusIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ErrorState } from '../../components/ui/Feedback';
import { SelectField, TextField } from '../../components/ui/Form';
import { useToast } from '../../components/ui/Toast';
import { isoToLocalInput, localInputToIso } from '../../lib/time';
import styles from './ImportPage.module.css';

export interface ManualEntryFormProps {
  devices: Device[];
  onSaved: () => void;
}

/** Field definitions drive both the inputs and the validation, so they cannot drift. */
const OPTIONAL_FIELDS = [
  { key: 'ambient_temp_c', label: 'Ambient temp', unit: '°C', min: -90, max: 70 },
  { key: 'humidity_pct', label: 'Humidity', unit: '%', min: 0, max: 100 },
  { key: 'barometric_pressure_hpa', label: 'Pressure', unit: 'hPa', min: 300, max: 1100 },
  { key: 'battery_voltage_v', label: 'Battery', unit: 'V', min: 0, max: 60 },
  { key: 'altitude_m', label: 'Altitude', unit: 'm', min: -500, max: 20000 },
  { key: 'gps_accuracy_m', label: 'GPS accuracy', unit: 'm', min: 0, max: 100000 },
] as const;

const TIRE_FIELDS = [
  { key: 'tire_fl_pressure_kpa', label: 'FL pressure' },
  { key: 'tire_fr_pressure_kpa', label: 'FR pressure' },
  { key: 'tire_rl_pressure_kpa', label: 'RL pressure' },
  { key: 'tire_rr_pressure_kpa', label: 'RR pressure' },
] as const;

type FieldKey = (typeof OPTIONAL_FIELDS)[number]['key'] | (typeof TIRE_FIELDS)[number]['key'];

export function ManualEntryForm({ devices, onSaved }: ManualEntryFormProps): JSX.Element {
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [recordedAt, setRecordedAt] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [values, setValues] = useState<Partial<Record<FieldKey, string>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const setValue = useCallback((key: FieldKey, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setFailure(null);

      const nextErrors: Record<string, string> = {};

      const iso = localInputToIso(recordedAt);
      if (!iso) nextErrors.recordedAt = 'Choose a date and time.';

      const lat = Number(latitude);
      const lon = Number(longitude);
      if (!latitude.trim() || !Number.isFinite(lat) || lat < -90 || lat > 90) {
        nextErrors.latitude = 'Between -90 and 90.';
      }
      if (!longitude.trim() || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        nextErrors.longitude = 'Between -180 and 180.';
      }

      const numeric: Partial<Record<FieldKey, number | null>> = {};

      for (const field of OPTIONAL_FIELDS) {
        const raw = values[field.key]?.trim() ?? '';
        if (!raw) {
          numeric[field.key] = null;
          continue;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
          nextErrors[field.key] = `Between ${field.min} and ${field.max} ${field.unit}.`;
          continue;
        }
        numeric[field.key] = parsed;
      }

      for (const field of TIRE_FIELDS) {
        const raw = values[field.key]?.trim() ?? '';
        if (!raw) {
          numeric[field.key] = null;
          continue;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1400) {
          nextErrors[field.key] = 'Between 0 and 1400 kPa.';
          continue;
        }
        numeric[field.key] = parsed;
      }

      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;

      setIsSaving(true);
      try {
        let targetDevice = deviceId || devices[0]?.id;
        if (!targetDevice) {
          const created = await createDevice({ name: 'Manual entries', notes: 'Typed by hand' });
          targetDevice = created.id;
        }

        const now = new Date().toISOString();
        const record: ReadingRecord = {
          id: newId('rdg'),
          device_id: targetDevice,
          recorded_at: iso!,
          // A hand-typed reading has no separate receive time; they are equal,
          // which makes the skew legitimately zero rather than fabricated.
          received_at: iso!,
          clock_skew_ms: 0,
          latitude: lat,
          longitude: lon,
          altitude_m: numeric.altitude_m ?? null,
          gps_accuracy_m: numeric.gps_accuracy_m ?? null,
          tire_fl_pressure_kpa: numeric.tire_fl_pressure_kpa ?? null,
          tire_fr_pressure_kpa: numeric.tire_fr_pressure_kpa ?? null,
          tire_rl_pressure_kpa: numeric.tire_rl_pressure_kpa ?? null,
          tire_rr_pressure_kpa: numeric.tire_rr_pressure_kpa ?? null,
          tire_fl_temp_c: null,
          tire_fr_temp_c: null,
          tire_rl_temp_c: null,
          tire_rr_temp_c: null,
          ambient_temp_c: numeric.ambient_temp_c ?? null,
          humidity_pct: numeric.humidity_pct ?? null,
          barometric_pressure_hpa: numeric.barometric_pressure_hpa ?? null,
          accel_x_g: null,
          accel_y_g: null,
          accel_z_g: null,
          battery_voltage_v: numeric.battery_voltage_v ?? null,
          extra: { entered_manually: true, entered_at: now },
        };

        await addReadings([record]);
        onSaved();
        toast.success('Reading saved');

        // Keep the device and position — consecutive manual entries are
        // usually from the same place — but clear the measured values.
        setValues({});
        setRecordedAt(isoToLocalInput(new Date().toISOString()));
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : 'The reading could not be saved.');
      } finally {
        setIsSaving(false);
      }
    },
    [recordedAt, latitude, longitude, values, deviceId, devices, onSaved, toast],
  );

  return (
    <Card>
      <CardHeader
        title="Enter a reading by hand"
        subtitle="For a single value read off a gauge"
        level={3}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide' : 'Show form'}
          </Button>
        }
      />
      {open && (
        <CardBody>
          <form className={styles.manualForm} onSubmit={submit}>
            {failure && <ErrorState error={new Error(failure)} compact />}

            <div className={styles.manualGrid}>
              {devices.length > 0 && (
                <SelectField
                  label="Device"
                  value={deviceId || devices[0]!.id}
                  onChange={(event) => setDeviceId(event.target.value)}
                  options={devices.map((device) => ({ value: device.id, label: device.name }))}
                />
              )}

              <TextField
                label="Recorded at"
                type="datetime-local"
                required
                value={recordedAt}
                error={errors.recordedAt}
                onChange={(event) => setRecordedAt(event.target.value)}
              />

              <TextField
                label="Latitude"
                type="number"
                step="any"
                required
                value={latitude}
                error={errors.latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="42.3398"
              />

              <TextField
                label="Longitude"
                type="number"
                step="any"
                required
                value={longitude}
                error={errors.longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="-71.0892"
              />

              {OPTIONAL_FIELDS.map((field) => (
                <TextField
                  key={field.key}
                  label={`${field.label} (${field.unit})`}
                  type="number"
                  step="any"
                  value={values[field.key] ?? ''}
                  error={errors[field.key]}
                  onChange={(event) => setValue(field.key, event.target.value)}
                />
              ))}

              {TIRE_FIELDS.map((field) => (
                <TextField
                  key={field.key}
                  label={`${field.label} (kPa)`}
                  type="number"
                  step="any"
                  value={values[field.key] ?? ''}
                  error={errors[field.key]}
                  onChange={(event) => setValue(field.key, event.target.value)}
                />
              ))}
            </div>

            <div className={styles.manualActions}>
              <p className={styles.note}>Blank fields are stored as "no reading", not as zero.</p>
              <Button
                type="submit"
                variant="primary"
                isLoading={isSaving}
                iconLeft={<PlusIcon size={15} />}
              >
                Save reading
              </Button>
            </div>
          </form>
        </CardBody>
      )}
    </Card>
  );
}
