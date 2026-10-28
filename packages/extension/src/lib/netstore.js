// Recorded traffic, in IndexedDB. The service worker is suspended after ~30s
// idle and everything in its memory dies with it, so the record of a page an
// agent opened ten minutes ago has to live somewhere that survives — the
// browser's own database, inside the agent profile (which already holds that
// site's cookies, so no new trust boundary). Modelled on testohelper's queue.
//
// Each record has a status:
//   buffer   — an ordinary session's traffic; pruned by age and count
//   pending  — a background job's, not yet written to its file; never pruned
//   written  — a job's, already on disk; pruned like buffer

const DB = "agent-bridge-net";
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const s = db.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
      s.createIndex("tab_ts", ["tabId", "ts"]);
      s.createIndex("status", "status");
      s.createIndex("ts", "ts");
      db.createObjectStore("meta");
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another context upgrading, or the browser closing it: open afresh next time.
      db.onversionchange = () => db.close();
      db.onclose = () => (dbp = null);
      resolve(db);
    };
    r.onerror = () => {
      dbp = null;
      reject(r.error);
    };
  });
  return dbp;
}

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** One transaction for the whole batch. Returns the ids given. */
export async function addMany(records) {
  if (!records.length) return [];
  const db = await open();
  const tx = db.transaction("entries", "readwrite");
  const store = tx.objectStore("entries");
  const ids = records.map((r) => req(store.add(r)));
  await done(tx);
  return Promise.all(ids);
}

/** A tab's records between two times, oldest first. */
export async function queryTab(tabId, { since = 0, until = Number.MAX_SAFE_INTEGER } = {}) {
  const db = await open();
  const idx = db.transaction("entries").objectStore("entries").index("tab_ts");
  return req(idx.getAll(IDBKeyRange.bound([tabId, since], [tabId, until])));
}

async function deleteWhere(range, indexName, keep) {
  const db = await open();
  const tx = db.transaction("entries", "readwrite");
  const idx = indexName ? tx.objectStore("entries").index(indexName) : tx.objectStore("entries");
  let n = 0;
  await new Promise((resolve, reject) => {
    const c = idx.openCursor(range);
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return resolve();
      if (!keep(cur.value)) {
        cur.delete();
        n++;
      }
      cur.continue();
    };
    c.onerror = () => reject(c.error);
  });
  await done(tx);
  return n;
}

/** A closed tab, or an agent asking to start clean. A job's unwritten records stay. */
export function clearTab(tabId, { keepPending = true } = {}) {
  return deleteWhere(
    IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]),
    "tab_ts",
    (r) => keepPending && r.status === "pending",
  );
}

/** A new browser session reuses tab ids; old records would land on new tabs. */
export function wipeUnpending() {
  return deleteWhere(null, null, (r) => r.status === "pending");
}

/** A job's unwritten records older than `olderThan`, up to about `maxBytes`. */
export async function takePending(jobId, { olderThan = Date.now(), maxBytes = 2_000_000 } = {}) {
  const db = await open();
  const idx = db.transaction("entries").objectStore("entries").index("status");
  const all = await req(idx.getAll(IDBKeyRange.only("pending")));
  const out = [];
  let bytes = 0;
  for (const r of all.sort((a, b) => a.id - b.id)) {
    if (r.jobId !== jobId || r.ts > olderThan) continue;
    bytes += JSON.stringify(r).length;
    if (out.length && bytes > maxBytes) break;
    out.push(r);
  }
  return out;
}

export async function markWritten(ids) {
  if (!ids?.length) return 0;
  const db = await open();
  const tx = db.transaction("entries", "readwrite");
  const store = tx.objectStore("entries");
  let n = 0;
  for (const id of ids) {
    const r = await req(store.get(id));
    if (r && r.status === "pending") {
      r.status = "written";
      store.put(r);
      n++;
    }
  }
  await done(tx);
  return n;
}

/**
 * Age, then per tab, then in total. Pending records are kept through all
 * three: losing them would lose a job's data. A hard backstop drops the oldest
 * pending past `maxPending` (a job whose daemon never comes back) and says how
 * many in meta.droppedPending.
 */
export async function prune({ perTab = 500, total = 20000, retainMs = 24 * 3600_000, maxPending = 100_000 } = {}) {
  const cutoff = Date.now() - retainMs;
  let removed = await deleteWhere(IDBKeyRange.upperBound(cutoff), "ts", (r) => r.status === "pending");

  const db = await open();
  const all = await req(db.transaction("entries").objectStore("entries").index("ts").getAll());
  const perTabSeen = new Map();
  const drop = new Set();
  let kept = 0;
  let pending = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i];
    if (r.status === "pending") {
      if (++pending > maxPending) drop.add(r.id);
      continue;
    }
    const n = (perTabSeen.get(r.tabId) || 0) + 1;
    perTabSeen.set(r.tabId, n);
    if (n > perTab || ++kept > total) drop.add(r.id);
  }
  if (drop.size) {
    const tx = db.transaction(["entries", "meta"], "readwrite");
    const store = tx.objectStore("entries");
    for (const id of drop) store.delete(id);
    const lost = Math.max(0, pending - maxPending);
    if (lost) {
      const m = tx.objectStore("meta");
      const prev = (await req(m.get("droppedPending"))) || 0;
      m.put(prev + lost, "droppedPending");
    }
    await done(tx);
    removed += drop.size;
  }
  return removed;
}

export async function stats() {
  const db = await open();
  const tx = db.transaction(["entries", "meta"]);
  const store = tx.objectStore("entries");
  const [count, pending, droppedPending] = await Promise.all([
    req(store.count()),
    req(store.index("status").count(IDBKeyRange.only("pending"))),
    req(tx.objectStore("meta").get("droppedPending")),
  ]);
  return { records: count, pending, droppedPending: droppedPending || 0 };
}

export async function getMeta(key) {
  const db = await open();
  return req(db.transaction("meta").objectStore("meta").get(key));
}

export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value, key);
  await done(tx);
}
