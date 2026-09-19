/**
 * IndexedDB access.
 *
 * This application has no server. Telemetry, devices, and saved designs live in
 * the browser, which means the storage layer has to be durable, hold tens of
 * thousands of rows, and survive a reload — ruling out `localStorage`, which is
 * synchronous and caps out around 5 MB.
 *
 * Raw IndexedDB rather than a wrapper library: the app needs four object stores
 * and about six operations, and a dependency here would be larger than the code
 * it replaced.
 *
 * Everything the user owns is in one place, so `exportAll` / `importAll` in
 * `store.ts` are the backup story. There is no sync — see the README.
 */

const DATABASE_NAME = 'stone';
const DATABASE_VERSION = 1;

export const STORE = {
  devices: 'devices',
  readings: 'readings',
  designs: 'designs',
  meta: 'meta',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let connection: Promise<IDBDatabase> | null = null;

/** Wrap a request in a promise, because IndexedDB predates them. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class StorageError extends Error {
  /** Underlying failure, for the console. Never rendered to the user. */
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.detail = detail;
  }
}

export function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('This browser does not support local storage.'));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE.devices)) {
        db.createObjectStore(STORE.devices, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE.readings)) {
        const readings = db.createObjectStore(STORE.readings, { keyPath: 'id' });
        // Time is the only index that earns its keep: every query is bounded by
        // a date range, and the rest of the filtering happens in memory.
        readings.createIndex('recorded_at', 'recorded_at');
        readings.createIndex('device_id', 'device_id');
      }

      if (!db.objectStoreNames.contains(STORE.designs)) {
        const designs = db.createObjectStore(STORE.designs, { keyPath: 'id' });
        designs.createIndex('updated_at', 'updated_at');
      }

      if (!db.objectStoreNames.contains(STORE.meta)) {
        db.createObjectStore(STORE.meta, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // Another tab upgrading the schema would otherwise leave this connection
      // holding a stale version and blocking the upgrade forever.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };

      resolve(db);
    };

    request.onerror = () =>
      reject(
        new StorageError(
          'Could not open local storage. Private browsing can block it.',
          request.error,
        ),
      );

    request.onblocked = () =>
      reject(new StorageError('Another tab is holding local storage open. Close it and reload.'));
  });

  return connection;
}

async function transaction<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(stores, mode);

  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new StorageError('Local storage write failed.', tx.error));
    tx.onabort = () => reject(new StorageError('Local storage write was aborted.', tx.error));
  });

  const result = await run(tx);
  await completion;
  return result;
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readonly');
  return promisify(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readonly');
  return promisify(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  await transaction(store, 'readwrite', (tx) => {
    tx.objectStore(store).put(value);
  });
}

/**
 * Bulk insert.
 *
 * Writes are batched into a handful of transactions rather than one per row:
 * importing 10,000 readings as 10,000 transactions takes minutes, while a few
 * large ones take under a second. `onProgress` drives the import UI.
 */
export async function putMany<T>(
  store: StoreName,
  values: T[],
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const BATCH = 2000;

  for (let offset = 0; offset < values.length; offset += BATCH) {
    const slice = values.slice(offset, offset + BATCH);
    await transaction(store, 'readwrite', (tx) => {
      const objectStore = tx.objectStore(store);
      for (const value of slice) objectStore.put(value);
    });
    onProgress?.(Math.min(offset + BATCH, values.length), values.length);
  }
}

export async function remove(store: StoreName, key: string): Promise<void> {
  await transaction(store, 'readwrite', (tx) => {
    tx.objectStore(store).delete(key);
  });
}

export async function clear(stores: StoreName[]): Promise<void> {
  await transaction(stores, 'readwrite', (tx) => {
    for (const store of stores) tx.objectStore(store).clear();
  });
}

export async function count(store: StoreName): Promise<number> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readonly');
  return promisify(tx.objectStore(store).count());
}

/** Small key/value corner for flags like "the sample data has been loaded". */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await getOne<{ key: string; value: T }>(STORE.meta, key);
  return row?.value;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await put(STORE.meta, { key, value });
}

/**
 * Rough storage usage, for the settings panel.
 *
 * `navigator.storage.estimate()` reports the whole origin, not just this
 * database, and browsers deliberately fuzz it. Treat it as indicative.
 */
export async function estimateUsage(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usedBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
    };
  } catch {
    return null;
  }
}
