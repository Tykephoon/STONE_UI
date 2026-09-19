/**
 * Devices.
 *
 * With no server there is nothing to authenticate, so a device is simply a
 * label used to group readings — no keys, no rotation, no online state. The
 * page exists so imports can be attributed to the right unit, and so a
 * device's history can be removed in one action.
 */
import { type FormEvent, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { createDevice, deleteDevice, listDevices, updateDevice } from '../../data/store';
import type { Device } from '../../data/types';
import { ChipIcon, DownloadIcon, PlusIcon, RefreshIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback';
import { TextAreaField, TextField } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useAction, useAsync } from '../../hooks/useAsync';
import { formatCount } from '../../lib/format';
import { formatDateTime, formatRelative } from '../../lib/time';
import styles from './DevicesPage.module.css';

export function DevicesPage(): JSX.Element {
  const toast = useToast();
  const state = useAsync((signal) => listDevices(signal), []);
  const devices = state.data?.devices ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const createAction = useAction(createDevice);
  const updateAction = useAction(updateDevice);
  const deleteAction = useAction(deleteDevice);

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

      const result = await createAction.run({ name: name.trim(), notes: notes.trim() || null });
      if (result.ok) {
        setCreateOpen(false);
        state.reload();
        toast.success('Device added', 'Import readings and attribute them to it.');
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
      const removed = result.data.removedReadings;
      setDeleting(null);
      state.reload();
      toast.success(
        'Device deleted',
        removed > 0 ? `${formatCount(removed)} readings were removed with it.` : undefined,
      );
    }
  }, [deleting, deleteAction, state, toast]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Devices</h1>
          <p className={styles.subtitle}>
            Labels for grouping readings. Imported data is attributed to whichever device you pick.
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={state.reload}
            isLoading={state.isFetching && !state.isLoading}
            iconLeft={<RefreshIcon size={15} />}
          >
            Refresh
          </Button>
          <Button variant="primary" onClick={openCreate} iconLeft={<PlusIcon size={15} />}>
            Add device
          </Button>
        </div>
      </header>

      {state.error ? (
        <ErrorState error={state.error} onRetry={state.reload} />
      ) : state.isLoading ? (
        <div className={styles.list}>
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} height={118} radius="var(--radius-lg)" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ChipIcon size={22} />}
            title="No devices yet"
            description="Add a device, then import a CSV of its readings. The importer can also create one for you."
            action={
              <Button variant="primary" onClick={openCreate}>
                Add a device
              </Button>
            }
          />
        </Card>
      ) : (
        <div className={styles.list}>
          {devices.map((device) => (
            <Card key={device.id}>
              <CardHeader
                title={device.name}
                level={3}
                subtitle={
                  device.last_reading_at
                    ? `Latest reading ${formatRelative(device.last_reading_at)}`
                    : 'No readings yet'
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
                    <dt>First reading</dt>
                    <dd>
                      {device.first_reading_at ? formatDateTime(device.first_reading_at) : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Latest reading</dt>
                    <dd>{device.last_reading_at ? formatDateTime(device.last_reading_at) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Added</dt>
                    <dd>{formatDateTime(device.created_at)}</dd>
                  </div>
                </dl>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader
          title="Getting data in"
          subtitle="There is no server, so readings arrive by import"
          level={3}
          actions={
            <Link to="/import">
              <Button size="sm" variant="secondary" iconLeft={<DownloadIcon size={15} />}>
                Import data
              </Button>
            </Link>
          }
        />
        <CardBody>
          <p className={styles.helpText}>
            Upload a CSV or JSON file, paste rows straight from a spreadsheet, or type a single
            reading by hand. The importer recognises common column names, checks every value
            against a plausible range, and shows you what it found before anything is saved.
          </p>
          <p className={styles.helpText}>
            Everything lives in this browser. Use <strong>Export backup</strong> on the import
            screen to move it to another machine — there is no account, and nothing syncs on its
            own.
          </p>
        </CardBody>
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add a device"
        description="A name to group readings under."
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
              Add
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

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete this device?"
        description={
          <>
            <strong>{deleting?.name}</strong> and its{' '}
            {formatCount(deleting?.reading_count ?? 0)} readings will be removed from this browser.
            Export a backup first if you might want them back.
          </>
        }
        confirmLabel="Delete device"
        destructive
        isPending={deleteAction.isPending}
      />
    </div>
  );
}
