/**
 * Device registration and key management.
 *
 * A device key is displayed exactly once, in a modal, immediately after being
 * minted. The server stores only its hash, so there is no route that can show
 * it again — the UI states that plainly rather than letting someone assume they
 * can come back for it.
 */
import { type FormEvent, useCallback, useState } from 'react';
import {
  createDevice,
  deleteDevice,
  listDevices,
  rotateDeviceKey,
  updateDevice,
} from '../../api/devices';
import type { Device } from '../../api/types';
import { ChipIcon, PlusIcon, RefreshIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { CopyField } from '../../components/ui/CopyField';
import { Badge, EmptyState, ErrorState, Skeleton, StatusDot } from '../../components/ui/Feedback';
import { TextAreaField, TextField } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { config } from '../../config';
import { useAction, useAsync } from '../../hooks/useAsync';
import { formatCount } from '../../lib/format';
import { formatDateTime, formatRelative } from '../../lib/time';
import styles from './DevicesPage.module.css';

/** A device is considered online if it posted within this window. */
const ONLINE_THRESHOLD_MS = 10 * 60_000;

export function DevicesPage(): JSX.Element {
  const toast = useToast();
  const state = useAsync((signal) => listDevices(signal), []);
  const devices = state.data?.devices ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const [rotating, setRotating] = useState<Device | null>(null);
  const [issuedKey, setIssuedKey] = useState<{ name: string; key: string } | null>(null);

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const createAction = useAction(createDevice);
  const updateAction = useAction(updateDevice);
  const deleteAction = useAction(deleteDevice);
  const rotateAction = useAction(rotateDeviceKey);

  const openCreate = useCallback(() => {
    setName('');
    setNotes('');
    createAction.reset();
    setCreateOpen(true);
  }, [createAction]);

  const handleCreate = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!name.trim()) return;

      const result = await createAction.run({
        name: name.trim(),
        notes: notes.trim() || null,
      });

      if (result.ok) {
        setCreateOpen(false);
        setIssuedKey({ name: result.data.device.name, key: result.data.device_key });
        state.reload();
        toast.success('Device registered', 'Copy the key now — it is not shown again.');
      }
    },
    [name, notes, createAction, state, toast],
  );

  const handleUpdate = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!editing) return;

      const result = await updateAction.run(editing.id, {
        name: name.trim(),
        notes: notes.trim() || null,
      });

      if (result.ok) {
        setEditing(null);
        state.reload();
        toast.success('Device updated');
      }
    },
    [editing, name, notes, updateAction, state, toast],
  );

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    const result = await deleteAction.run(deleting.id);
    if (result.ok) {
      setDeleting(null);
      state.reload();
      toast.success('Device deleted', 'Its readings were removed as well.');
    }
  }, [deleting, deleteAction, state, toast]);

  const handleRotate = useCallback(async () => {
    if (!rotating) return;
    const result = await rotateAction.run(rotating.id);
    if (result.ok) {
      const device = rotating;
      setRotating(null);
      setIssuedKey({ name: device.name, key: result.data.device_key });
      state.reload();
      toast.warning('Key rotated', 'The previous key stopped working immediately.');
    }
  }, [rotating, rotateAction, state, toast]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Devices</h1>
          <p className={styles.subtitle}>
            Each device authenticates to the ingest endpoint with its own key.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} iconLeft={<PlusIcon size={15} />}>
          Register device
        </Button>
      </header>

      {state.error ? (
        <ErrorState error={state.error} onRetry={state.reload} />
      ) : state.isLoading ? (
        <div className={styles.list}>
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} height={132} radius="var(--radius-lg)" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ChipIcon size={22} />}
            title="No devices yet"
            description="Register your first Pico to get a device key. Point the device at the ingest endpoint and readings will start appearing on the dashboard."
            action={
              <Button variant="primary" onClick={openCreate}>
                Register a device
              </Button>
            }
          />
        </Card>
      ) : (
        <div className={styles.list}>
          {devices.map((device) => {
            const online =
              device.last_seen_at !== null &&
              Date.now() - Date.parse(device.last_seen_at) < ONLINE_THRESHOLD_MS;

            return (
              <Card key={device.id}>
                <CardHeader
                  title={device.name}
                  level={3}
                  subtitle={
                    <span className={styles.statusLine}>
                      <StatusDot tone={online ? 'good' : 'neutral'} pulse={online} />
                      {online ? 'Online' : 'Idle'}
                      {device.last_seen_at && (
                        <>
                          <span className={styles.separator}>·</span>
                          <span title={formatDateTime(device.last_seen_at)}>
                            last posted {formatRelative(device.last_seen_at)}
                          </span>
                        </>
                      )}
                    </span>
                  }
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(device);
                          setName(device.name);
                          setNotes(device.notes ?? '');
                          updateAction.reset();
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setRotating(device)}
                        iconLeft={<RefreshIcon size={14} />}
                      >
                        Rotate key
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(device)}>
                        Delete
                      </Button>
                    </>
                  }
                />
                <CardBody>
                  {device.notes && <p className={styles.notes}>{device.notes}</p>}

                  <dl className={styles.meta}>
                    <div>
                      <dt>Readings</dt>
                      <dd>{formatCount(device.reading_count)}</dd>
                    </div>
                    <div>
                      <dt>Key prefix</dt>
                      <dd className={styles.mono}>{device.key_prefix}…</dd>
                    </div>
                    <div>
                      <dt>Registered</dt>
                      <dd>{formatDateTime(device.created_at)}</dd>
                    </div>
                    <div>
                      <dt>Key rotated</dt>
                      <dd>
                        {device.key_rotated_at ? formatDateTime(device.key_rotated_at) : 'Never'}
                      </dd>
                    </div>
                  </dl>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader
          title="Posting readings"
          subtitle="What a device needs to send"
          level={3}
        />
        <CardBody>
          <p className={styles.helpText}>
            Devices authenticate with their key as a bearer token. Send one reading, or a batch
            under a <code>readings</code> array. Unknown fields are preserved rather than dropped.
          </p>
          <pre className={styles.snippet}>{`POST ${config.apiBaseUrl}/api/ingest
Authorization: Bearer stk_<your-device-key>
Content-Type: application/json

{
  "recorded_at": "2026-09-19T10:04:00Z",
  "latitude": 42.3398,
  "longitude": -71.0892,
  "altitude_m": 14.2,
  "gps_accuracy_m": 4.5,
  "tires": {
    "front_left":  { "pressure_kpa": 228.4, "temp_c": 31.2 },
    "front_right": { "pressure_kpa": 229.1, "temp_c": 30.8 },
    "rear_left":   { "pressure_kpa": 235.0, "temp_c": 33.4 },
    "rear_right":  { "pressure_kpa": 234.2, "temp_c": 33.1 }
  },
  "sensors": {
    "ambient_temp_c": 18.4,
    "humidity_pct": 61.2,
    "barometric_pressure_hpa": 1014.2,
    "accel_x_g": 0.02,
    "accel_y_g": -0.01,
    "accel_z_g": 1.00,
    "battery_voltage_v": 12.4
  },
  "firmware": "1.4.2"
}`}</pre>
        </CardBody>
      </Card>

      {/* ---- register ---- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Register a device"
        description="You will be shown a key once. Store it on the device immediately."
        busy={createAction.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              isLoading={createAction.isPending}
              disabled={!name.trim()}
            >
              Register
            </Button>
          </>
        }
      >
        <form className={styles.form} onSubmit={handleCreate}>
          {createAction.error && <ErrorState error={createAction.error} compact />}
          <TextField
            label="Name"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Pico-01 · Trail Rig"
            error={createAction.error?.fieldErrors().name}
            maxLength={80}
          />
          <TextAreaField
            label="Notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Hardware, sensors fitted, where it lives…"
            maxLength={500}
            hint="Optional. Shown on this page only."
          />
        </form>
      </Modal>

      {/* ---- edit ---- */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit device"
        busy={updateAction.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleUpdate} isLoading={updateAction.isPending}>
              Save changes
            </Button>
          </>
        }
      >
        <form className={styles.form} onSubmit={handleUpdate}>
          {updateAction.error && <ErrorState error={updateAction.error} compact />}
          <TextField
            label="Name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
          />
          <TextAreaField
            label="Notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={500}
          />
        </form>
      </Modal>

      {/* ---- the one and only display of a key ---- */}
      <Modal
        open={issuedKey !== null}
        onClose={() => setIssuedKey(null)}
        title="Device key"
        description={`For ${issuedKey?.name ?? ''}. This is the only time it will be shown.`}
        footer={
          <Button variant="primary" onClick={() => setIssuedKey(null)}>
            I have saved it
          </Button>
        }
      >
        <div className={styles.keyBlock}>
          <CopyField value={issuedKey?.key ?? ''} label="Bearer token" />
          <div className={styles.keyWarning}>
            <Badge tone="warning">Store securely</Badge>
            <p>
              Only a hash of this key is kept on the server, so it cannot be recovered. If it is
              lost or exposed, rotate it — rotation invalidates the previous key immediately.
            </p>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={rotating !== null}
        onClose={() => setRotating(null)}
        onConfirm={handleRotate}
        title="Rotate this device key?"
        description={
          <>
            The current key for <strong>{rotating?.name}</strong> stops working immediately, and the
            device will be rejected until it is reconfigured with the new key. Existing readings are
            unaffected.
          </>
        }
        confirmLabel="Rotate key"
        isPending={rotateAction.isPending}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete this device?"
        description={
          <>
            <strong>{deleting?.name}</strong> and all{' '}
            {formatCount(deleting?.reading_count ?? 0)} of its readings will be permanently removed.
            This cannot be undone.
          </>
        }
        confirmLabel="Delete device"
        destructive
        isPending={deleteAction.isPending}
      />
    </div>
  );
}
