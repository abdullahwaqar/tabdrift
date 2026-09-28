const DB_NAME = "tabdrift";
const DB_VERSION = 1;
const STORE = "images";
const BACKGROUND_KEY = "background";

/** Pictures bigger than this are refused, so a stray RAW file can't bloat the profile. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE)) {
                    request.result.createObjectStore(STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                dbPromise = null;
                reject(request.error);
            };
        });
    }
    return dbPromise;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const request = work(tx.objectStore(STORE));
                tx.oncomplete = () => resolve(request.result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            }),
    );
}

export async function loadBackgroundImage(): Promise<Blob | null> {
    const value = await run<unknown>("readonly", (store) => store.get(BACKGROUND_KEY));
    return value instanceof Blob ? value : null;
}

export async function saveBackgroundImage(blob: Blob): Promise<void> {
    await run("readwrite", (store) => store.put(blob, BACKGROUND_KEY));
}

export async function clearBackgroundImage(): Promise<void> {
    await run("readwrite", (store) => store.delete(BACKGROUND_KEY));
}
