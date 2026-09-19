/**
 * Import, export, and manual entry.
 *
 * This is how data gets in, so it is built to be forgiving about what it
 * accepts and unforgiving about what it stores: common column spellings are
 * recognised automatically, unknown columns are preserved rather than dropped,
 * and every value is range-checked before anything is written. Nothing is saved
 * until the preview has been seen.
 */
import { type DragEvent, useCallback, useMemo, useRef, useState } from 'react';
import { parseReadingsCsv, templateCsv, type ParseResult } from '../../data/csv';
import { downloadBackup, downloadBlob } from '../../data/export';
import {
  MAX_READINGS,
  addReadings,
  clearEverything,
  createDevice,
  deleteAllReadings,
  importBackup,
  listDevices,
  type ReadingRecord,
} from '../../data/store';
import { estimateUsage } from '../../data/db';
import { DownloadIcon, InboxIcon, PlusIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Badge, EmptyState, ErrorState, Spinner } from '../../components/ui/Feedback';
import { SelectField, TextField } from '../../components/ui/Form';
import { ConfirmDialog } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useAsync } from '../../hooks/useAsync';
import { formatBytes, formatCount } from '../../lib/format';
import { formatDateTime } from '../../lib/time';
import { ManualEntryForm } from './ManualEntryForm';
import styles from './ImportPage.module.css';

const NEW_DEVICE = '__new__';

type Stage = 'idle' | 'parsing' | 'preview' | 'saving';

export function ImportPage(): JSX.Element {
  const toast = useToast();
  const devicesState = useAsync((signal) => listDevices(signal), []);
  const devices = devicesState.data?.devices ?? [];

  const usageState = useAsync(() => estimateUsage(), []);

  const [stage, setStage] = useState<Stage>('idle');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState<{ written: number; total: number } | null>(null);

  const [deviceChoice, setDeviceChoice] = useState<string>('');
  const [newDeviceName, setNewDeviceName] = useState('Imported readings');

  const [confirmClear, setConfirmClear] = useState<'readings' | 'everything' | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStage('idle');
    setParsed(null);
    setSourceName(null);
    setFatalError(null);
    setPasted('');
    setProgress(null);
  }, []);

  /** Parse text into a preview. Nothing is written yet. */
  const handleText = useCallback(
    (text: string, label: string) => {
      setStage('parsing');
      setFatalError(null);
      setSourceName(label);

      // Yield a frame so the spinner paints before a large parse blocks.
      setTimeout(() => {
        try {
          const result = parseReadingsCsv(text, 'pending');
          setParsed(result);
          setStage('preview');

          if (result.readings.length === 0 && result.issues.length > 0) {
            setFatalError('No usable rows were found. See the problems listed below.');
          }
        } catch (cause) {
          setStage('idle');
          setFatalError(
            cause instanceof Error ? cause.message : 'That file could not be read as CSV.',
          );
        }
      }, 16);
    },
    [],
  );

  const handleFile = useCallback(
    async (file: File) => {
      // A JSON file is either a backup or an export; both take a different path.
      if (file.name.toLowerCase().endsWith('.json')) {
        try {
          const text = await file.text();
          const payload = JSON.parse(text) as { format?: string; readings?: unknown };

          if (payload.format === 'stone-backup') {
            const counts = await importBackup(payload, { replace: false });
            devicesState.reload();
            toast.success(
              'Backup restored',
              `${formatCount(counts.readings)} readings, ${counts.devices} devices, ${counts.designs} designs.`,
            );
            reset();
            return;
          }

          setFatalError(
            'That JSON file is not a Stone backup. Export a CSV from your source instead, or use a backup file.',
          );
        } catch (cause) {
          setFatalError(
            cause instanceof Error ? cause.message : 'That file could not be read as JSON.',
          );
        }
        return;
      }

      handleText(await file.text(), file.name);
    },
    [handleText, devicesState, toast, reset],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  /** Commit the previewed rows. */
  const commit = useCallback(async () => {
    if (!parsed || parsed.readings.length === 0) return;

    setStage('saving');
    setProgress({ written: 0, total: parsed.readings.length });

    try {
      let deviceId = deviceChoice;

      if (!deviceId || deviceId === NEW_DEVICE) {
        const created = await createDevice({
          name: newDeviceName.trim() || 'Imported readings',
          notes: sourceName ? `Imported from ${sourceName}` : null,
        });
        deviceId = created.id;
      }

      // The parser used a placeholder; attribute the rows now that the device
      // is known.
      const records: ReadingRecord[] = parsed.readings.map((reading) =>
        reading.device_id === 'pending' ? { ...reading, device_id: deviceId } : reading,
      );

      await addReadings(records, (written, total) => setProgress({ written, total }));

      devicesState.reload();
      usageState.reload();
      toast.success(
        'Import complete',
        `${formatCount(records.length)} readings added. They are stored in this browser.`,
      );
      reset();
    } catch (cause) {
      setStage('preview');
      setProgress(null);
      setFatalError(cause instanceof Error ? cause.message : 'The import could not be saved.');
    }
  }, [parsed, deviceChoice, newDeviceName, sourceName, devicesState, usageState, toast, reset]);

  const handleBackupFile = useCallback(
    async (file: File) => {
      try {
        const payload = JSON.parse(await file.text()) as unknown;
        const counts = await importBackup(payload, { replace: true });
        devicesState.reload();
        usageState.reload();
        toast.success(
          'Backup restored',
          `${formatCount(counts.readings)} readings, ${counts.devices} devices, ${counts.designs} designs.`,
        );
      } catch (cause) {
        toast.error(
          'Restore failed',
          cause instanceof Error ? cause.message : 'That file is not a Stone backup.',
        );
      }
    },
    [devicesState, usageState, toast],
  );

  const previewRows = useMemo(() => parsed?.readings.slice(0, 8) ?? [], [parsed]);

  const deviceOptions = [
    ...devices.map((device) => ({ value: device.id, label: device.name })),
    { value: NEW_DEVICE, label: '＋ Create a new device' },
  ];

  const usage = usageState.data;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Import data</h1>
          <p className={styles.subtitle}>
            Upload a CSV, paste rows from a spreadsheet, or enter a reading by hand. Everything is
            stored in this browser.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={async () => {
            const count = await downloadBackup();
            toast.success('Backup downloaded', `${formatCount(count)} readings included.`);
          }}
          iconLeft={<DownloadIcon size={15} />}
        >
          Export backup
        </Button>
      </header>

      {fatalError && <ErrorState error={new Error(fatalError)} />}

      {/* ---- upload ---- */}
      {stage !== 'preview' && stage !== 'saving' && (
        <Card>
          <CardHeader title="Upload a file" subtitle="CSV, or a Stone backup in JSON" level={3} />
          <CardBody>
            <div
              className={[styles.dropZone, isDragging ? styles.dropZoneActive : '']
                .filter(Boolean)
                .join(' ')}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click();
              }}
              role="button"
              tabIndex={0}
              aria-label="Choose a file to import"
            >
              {stage === 'parsing' ? (
                <>
                  <Spinner size={22} />
                  <p className={styles.dropText}>Reading {sourceName}…</p>
                </>
              ) : (
                <>
                  <span className={styles.dropIcon} aria-hidden="true">
                    <InboxIcon size={22} />
                  </span>
                  <p className={styles.dropText}>
                    <strong>Drop a file here</strong> or click to choose
                  </p>
                  <p className={styles.dropHint}>
                    Up to {formatCount(MAX_READINGS)} readings. Nothing is uploaded anywhere.
                  </p>
                </>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.json,text/csv,application/json"
              className={styles.hiddenInput}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                // Allow re-selecting the same file after a failed attempt.
                event.target.value = '';
              }}
            />

            <div className={styles.pasteSection}>
              <label className={styles.pasteLabel} htmlFor="paste-area">
                …or paste rows
              </label>
              <textarea
                id="paste-area"
                className={styles.pasteArea}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder={
                  'recorded_at,latitude,longitude,ambient_temp_c\n2026-09-19T10:04:00Z,42.3398,-71.0892,18.4'
                }
                rows={4}
                spellCheck={false}
              />
              <div className={styles.pasteActions}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!pasted.trim()}
                  onClick={() => handleText(pasted, 'pasted text')}
                >
                  Parse pasted rows
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    downloadBlob(templateCsv(), 'stone-template.csv', 'text/csv;charset=utf-8')
                  }
                >
                  Download a template
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---- preview ---- */}
      {(stage === 'preview' || stage === 'saving') && parsed && (
        <Card>
          <CardHeader
            title="Preview"
            subtitle={`${sourceName ?? 'Input'} · ${formatCount(parsed.totalRows)} rows read`}
            level={3}
            actions={
              <Button size="sm" variant="ghost" onClick={reset} disabled={stage === 'saving'}>
                Start over
              </Button>
            }
          />
          <CardBody>
            <div className={styles.summary}>
              <Badge tone={parsed.readings.length > 0 ? 'good' : 'critical'}>
                {formatCount(parsed.readings.length)} valid
              </Badge>
              {parsed.issues.length > 0 && (
                <Badge tone="warning">{parsed.issues.length} problem{parsed.issues.length === 1 ? '' : 's'}</Badge>
              )}
              <Badge tone="neutral">
                {parsed.mapping.recognised.size} recognised column
                {parsed.mapping.recognised.size === 1 ? '' : 's'}
              </Badge>
              {parsed.mapping.extras.size > 0 && (
                <Badge tone="accent">
                  {parsed.mapping.extras.size} kept as extra
                  {parsed.mapping.extras.size === 1 ? '' : 's'}
                </Badge>
              )}
            </div>

            {parsed.mapping.extras.size > 0 && (
              <p className={styles.note}>
                Unrecognised columns are preserved on each reading and shown on its detail page:{' '}
                {[...parsed.mapping.extras.values()].slice(0, 6).join(', ')}
                {parsed.mapping.extras.size > 6 ? ', …' : ''}
              </p>
            )}

            {parsed.issues.length > 0 && (
              <div className={styles.issues}>
                <p className={styles.issuesTitle}>
                  Rows with problems are skipped; the rest still import.
                </p>
                <ul className={styles.issueList}>
                  {parsed.issues.slice(0, 12).map((issue, index) => (
                    <li key={`${issue.line}-${issue.field}-${index}`}>
                      <span className={styles.issueLine}>Line {issue.line}</span>
                      <span className={styles.issueField}>{issue.field}</span>
                      <span className={styles.issueMessage}>{issue.message}</span>
                    </li>
                  ))}
                </ul>
                {parsed.issues.length > 12 && (
                  <p className={styles.note}>…and {parsed.issues.length - 12} more.</p>
                )}
              </div>
            )}

            {previewRows.length > 0 && (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Recorded</th>
                      <th scope="col">Latitude</th>
                      <th scope="col">Longitude</th>
                      <th scope="col">Ambient</th>
                      <th scope="col">Tyres (FL/FR/RL/RR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((reading) => (
                      <tr key={reading.id}>
                        <td>{formatDateTime(reading.recorded_at)}</td>
                        <td>{reading.latitude.toFixed(5)}</td>
                        <td>{reading.longitude.toFixed(5)}</td>
                        <td>
                          {reading.ambient_temp_c === null
                            ? '—'
                            : `${reading.ambient_temp_c.toFixed(1)} °C`}
                        </td>
                        <td className={styles.mono}>
                          {[
                            reading.tire_fl_pressure_kpa,
                            reading.tire_fr_pressure_kpa,
                            reading.tire_rl_pressure_kpa,
                            reading.tire_rr_pressure_kpa,
                          ]
                            .map((value) => (value === null ? '—' : value.toFixed(0)))
                            .join(' / ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.readings.length > previewRows.length && (
                  <p className={styles.note}>
                    Showing the first {previewRows.length} of{' '}
                    {formatCount(parsed.readings.length)}.
                  </p>
                )}
              </div>
            )}

            {parsed.readings.length > 0 && (
              <div className={styles.commit}>
                <SelectField
                  label="Attribute to"
                  value={deviceChoice || (devices[0]?.id ?? NEW_DEVICE)}
                  onChange={(event) => setDeviceChoice(event.target.value)}
                  options={deviceOptions}
                />

                {(deviceChoice === NEW_DEVICE || devices.length === 0) && (
                  <TextField
                    label="New device name"
                    value={newDeviceName}
                    onChange={(event) => setNewDeviceName(event.target.value)}
                    maxLength={80}
                  />
                )}

                {stage === 'saving' && progress ? (
                  <div className={styles.progress}>
                    <div
                      className={styles.progressBar}
                      style={{ width: `${(progress.written / progress.total) * 100}%` }}
                    />
                    <span className={styles.progressLabel}>
                      Saving {formatCount(progress.written)} of {formatCount(progress.total)}…
                    </span>
                  </div>
                ) : (
                  <Button
                    variant="primary"
                    onClick={commit}
                    iconLeft={<PlusIcon size={15} />}
                  >
                    Import {formatCount(parsed.readings.length)} readings
                  </Button>
                )}
              </div>
            )}

            {parsed.readings.length === 0 && (
              <EmptyState
                compact
                title="Nothing to import"
                description="Every row was rejected. Check the problems above, or download the template to see the expected shape."
              />
            )}
          </CardBody>
        </Card>
      )}

      {/* ---- manual entry ---- */}
      <ManualEntryForm
        devices={devices}
        onSaved={() => {
          devicesState.reload();
          usageState.reload();
        }}
      />

      {/* ---- accepted columns ---- */}
      <Card>
        <CardHeader
          title="What the importer accepts"
          subtitle="Only three columns are required"
          level={3}
        />
        <CardBody>
          <p className={styles.helpText}>
            <strong>Required:</strong> <code>recorded_at</code>, <code>latitude</code>,{' '}
            <code>longitude</code>. Timestamps may be ISO-8601 (
            <code>2026-09-19T10:04:00Z</code>) or the <code>YYYY-MM-DD HH:MM:SS</code> form
            spreadsheets produce — the latter is read as UTC.
          </p>
          <p className={styles.helpText}>
            <strong>Recognised:</strong> <code>altitude_m</code>, <code>gps_accuracy_m</code>,{' '}
            <code>ambient_temp_c</code>, <code>humidity_pct</code>,{' '}
            <code>barometric_pressure_hpa</code>, <code>battery_voltage_v</code>,{' '}
            <code>accel_x_g</code>/<code>_y_</code>/<code>_z_</code>, and{' '}
            <code>tire_fl_pressure_kpa</code> style names for all four wheels. Common aliases work
            too — <code>lat</code>, <code>lon</code>, <code>timestamp</code>,{' '}
            <code>temperature</code>, <code>battery</code>.
          </p>
          <p className={styles.helpText}>
            <strong>Anything else</strong> is kept against the reading and shown on its detail
            page, so nothing in your file is lost.
          </p>
        </CardBody>
      </Card>

      {/* ---- storage ---- */}
      <Card>
        <CardHeader
          title="Stored in this browser"
          subtitle="No account, no sync, no server"
          level={3}
        />
        <CardBody>
          <p className={styles.helpText}>
            Clearing your browser's site data will delete everything here. Export a backup before
            switching machines or clearing history — it is the only copy.
          </p>

          {usage && usage.quotaBytes > 0 && (
            <p className={styles.note}>
              This site is using about {formatBytes(usage.usedBytes)} of roughly{' '}
              {formatBytes(usage.quotaBytes)} available.
            </p>
          )}

          <div className={styles.dangerRow}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => backupInputRef.current?.click()}
            >
              Restore a backup
            </Button>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              className={styles.hiddenInput}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleBackupFile(file);
                event.target.value = '';
              }}
            />
            <Button variant="danger" size="sm" onClick={() => setConfirmClear('readings')}>
              Delete all readings
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmClear('everything')}>
              Delete everything
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmClear !== null}
        onClose={() => setConfirmClear(null)}
        onConfirm={async () => {
          if (confirmClear === 'readings') {
            await deleteAllReadings();
            toast.success('Readings deleted');
          } else {
            await clearEverything();
            toast.success('Everything deleted');
          }
          setConfirmClear(null);
          devicesState.reload();
          usageState.reload();
        }}
        title={confirmClear === 'readings' ? 'Delete all readings?' : 'Delete everything?'}
        description={
          confirmClear === 'readings'
            ? 'Every reading in this browser will be removed. Devices and saved designs are kept. Restoring needs a backup file.'
            : 'Readings, devices, and saved designs will all be removed from this browser. Restoring needs a backup file.'
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
