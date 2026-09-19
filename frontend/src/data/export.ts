/**
 * File downloads.
 *
 * Everything is generated in the browser from the local database — there is no
 * server to ask for a file, so the app builds the bytes and hands them to an
 * object URL.
 */
import { toCsv } from './csv';
import { type ReadingFilters, exportAll, listDevices, readingRecordsFor } from './store';

export function downloadBlob(contents: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** Export the current filter selection as CSV or JSON. */
export async function exportReadings(
  options: ReadingFilters & { format: 'csv' | 'json' },
): Promise<number> {
  const { format, ...filters } = options;
  const records = await readingRecordsFor(filters);
  const { devices } = await listDevices();
  const names = new Map(devices.map((device) => [device.id, device.name]));

  if (format === 'csv') {
    downloadBlob(toCsv(records, names), `readings-${stamp()}.csv`, 'text/csv;charset=utf-8');
  } else {
    downloadBlob(
      JSON.stringify({ readings: records }, null, 2),
      `readings-${stamp()}.json`,
      'application/json',
    );
  }

  return records.length;
}

/**
 * Export everything — readings, devices, and designs — as a restorable backup.
 *
 * This is the only way data moves between browsers or machines, so it is
 * surfaced prominently in the import/export screen rather than buried.
 */
export async function downloadBackup(): Promise<number> {
  const backup = await exportAll();
  downloadBlob(
    JSON.stringify(backup),
    `stone-backup-${stamp()}.json`,
    'application/json',
  );
  return backup.readings.length;
}
