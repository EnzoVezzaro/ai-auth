// Wallet-origin grants kept in IndexedDB so a wallet reload can still confirm
// a session. Only the public signed envelope is stored; no private key material.
// The adapter is injected so tests use an in-memory fake; the IndexedDB adapter
// below is a thin wrapper over one object store named "sessions".

export const GRANT_STORE_NAME = "sessions";
const DEFAULT_DB_NAME = "ai-auth-wallet";
const DEFAULT_DB_VERSION = 1;

/** One durable record per audience and request nonce. */
export function grantKey(audience, requestNonce) {
  if (
    typeof audience !== "string" ||
    typeof requestNonce !== "string" ||
    !audience ||
    !requestNonce
  )
    throw new TypeError("An audience and request nonce are required");
  return `${audience}::${requestNonce}`;
}

/**
 * In-memory adapter. `backing` can be shared by several adapters to model a
 * wallet reload: a new adapter over the same backing sees the same grants.
 */
export function memoryGrantAdapter({ backing = new Map() } = {}) {
  return {
    async get(key) {
      return backing.has(key) ? structuredClone(backing.get(key)) : null;
    },
    async put(key, record) {
      backing.set(key, structuredClone(record));
    },
    async all() {
      return [...backing.entries()].map(([key, record]) => ({
        key,
        record: structuredClone(record),
      }));
    },
    async clear() {
      backing.clear();
    },
  };
}

/** Thin IndexedDB wrapper: one "sessions" store with explicit audience+nonce keys. */
export function indexedDbGrantAdapter({
  dbName = DEFAULT_DB_NAME,
  version = DEFAULT_DB_VERSION,
  factory = globalThis.indexedDB,
} = {}) {
  let dbPromise = null;
  function open() {
    if (!factory) throw new TypeError("IndexedDB is not available");
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = factory.open(dbName, version);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(GRANT_STORE_NAME))
            db.createObjectStore(GRANT_STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db
          .transaction(GRANT_STORE_NAME, "readonly")
          .objectStore(GRANT_STORE_NAME)
          .get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    },
    async put(key, record) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(GRANT_STORE_NAME, "readwrite");
        transaction.objectStore(GRANT_STORE_NAME).put(record, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    },
    async all() {
      const db = await open();
      if (!db.objectStoreNames.contains(GRANT_STORE_NAME)) return [];
      return new Promise((resolve, reject) => {
        const request = db
          .transaction(GRANT_STORE_NAME, "readonly")
          .objectStore(GRANT_STORE_NAME)
          .openCursor();
        const rows = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(rows);
          rows.push({ key: cursor.key, record: cursor.value });
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    },
    async clear() {
      const db = await open();
      if (!db.objectStoreNames.contains(GRANT_STORE_NAME)) return;
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(GRANT_STORE_NAME, "readwrite");
        transaction.objectStore(GRANT_STORE_NAME).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    },
  };
}

/** Forget every durable grant, for example when the wallet is removed. */
export async function clearGrants({ adapter = indexedDbGrantAdapter() } = {}) {
  if (typeof adapter.clear !== "function")
    throw new TypeError("A grant adapter with clear is required");
  await adapter.clear();
}

/**
 * Store and read approved grants. `adapter` supplies the durable key/value
 * operations; every record is keyed by audience plus request nonce.
 */
export function createGrantStore({
  adapter = indexedDbGrantAdapter(),
  now = () => Date.now(),
} = {}) {
  if (
    !adapter ||
    typeof adapter.get !== "function" ||
    typeof adapter.put !== "function"
  )
    throw new TypeError("A grant adapter with get and put is required");

  return {
    /** Open grants, for dashboards that show where this key is connected. */
    async list() {
      if (typeof adapter.all !== "function") return [];
      const rows = await adapter.all();
      return rows
        .map(({ record }) => record)
        .filter(
          (record) =>
            record &&
            record.ended !== true &&
            (record.expiresAt === null || record.expiresAt > now()),
        );
    },

    async save(consent, { audience, room, requestNonce, at = now() } = {}) {
      const payload = consent?.body?.payload;
      if (!payload || typeof audience !== "string" || typeof room !== "string")
        throw new TypeError("A consent, audience and room are required");
      // A renewal carries its own request nonce but keeps the session's stable
      // identity. Callers pass the original nonce to replace that one record,
      // so the superseded (broader) consent is never left resumable.
      const id = requestNonce ?? payload.requestNonce;
      const record = {
        audience,
        requestNonce: id,
        room,
        capabilities: [...(payload.capabilities ?? [])],
        expiresAt: payload.expiresAt,
        idleTimeoutMs: payload.idleTimeoutMs ?? null,
        issuedAt: payload.issuedAt,
        lastActivity: at,
        ended: false,
        consent,
      };
      await adapter.put(grantKey(audience, id), record);
      return record;
    },
    get(audience, requestNonce) {
      return adapter.get(grantKey(audience, requestNonce));
    },
    async markEnded(audience, requestNonce) {
      const key = grantKey(audience, requestNonce);
      const record = await adapter.get(key);
      if (!record) return false;
      await adapter.put(key, { ...record, ended: true });
      return true;
    },
    async touch(audience, requestNonce, at = now()) {
      const key = grantKey(audience, requestNonce);
      const record = await adapter.get(key);
      if (!record) return false;
      await adapter.put(key, { ...record, lastActivity: at });
      return true;
    },
  };
}
