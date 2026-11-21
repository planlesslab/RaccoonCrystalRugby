// Local demo backend: a tiny JSON database in localStorage, synced across
// tabs on the same device with BroadcastChannel. Same API as the Firebase
// backend, so you can try the game (and develop it) without any setup.
//
// Crystal Chaos streams player positions many times a second, so the data is
// split into small "buckets" (one per player, one per room field) instead of
// one big blob. That way two tabs writing at the same moment never overwrite
// each other's changes.

const PREFIX = "crystal-chaos:";

const split = (path) => path.split("/").filter(Boolean);

/** How many path segments make up one storage bucket. */
function bucketDepth(parts) {
  if (parts[0] !== "rooms") return 1;
  if (parts[2] === "players" || parts[2] === "pos") return 4; // rooms/CODE/players/UID
  return 3;                                                     // rooms/CODE/field
}

function getAt(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

function setAt(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = JSON.parse(JSON.stringify(value));
}

function loadKey(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveKey(key, value) {
  const empty = value == null || (typeof value === "object" && !Object.keys(value).length);
  if (empty) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
function keysUnder(parts) {
  const p = PREFIX + parts.join("/") + "/";
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(p)) out.push(k);
  }
  return out;
}

function readAt(parts) {
  const depth = bucketDepth(parts);
  if (parts.length >= depth) {
    const bucket = loadKey(PREFIX + parts.slice(0, depth).join("/"));
    return getAt(bucket, parts.slice(depth));
  }
  // Assemble a bigger object (e.g. a whole room) from its buckets.
  const keys = keysUnder(parts);
  if (!keys.length) return null;
  const out = {};
  const base = PREFIX.length + parts.join("/").length + 1;
  for (const k of keys) {
    const v = loadKey(k);
    if (v !== null) setAt(out, split(k.slice(base)), v);
  }
  return Object.keys(out).length ? out : null;
}

function writeAt(parts, value) {
  const depth = bucketDepth(parts);
  if (parts.length >= depth) {
    const key = PREFIX + parts.slice(0, depth).join("/");
    const rest = parts.slice(depth);
    if (!rest.length) return saveKey(key, value);
    const bucket = loadKey(key) || {};
    setAt(bucket, rest, value);
    return saveKey(key, bucket);
  }
  // Replacing something above bucket level: clear it, then write each child.
  for (const k of keysUnder(parts)) localStorage.removeItem(k);
  localStorage.removeItem(PREFIX + parts.join("/"));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) writeAt([...parts, k], v);
  }
}

export function createLocalBackend() {
  let uid = sessionStorage.getItem("crystal-chaos-uid");
  if (!uid) {
    uid = "local-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("crystal-chaos-uid", uid);
  }

  const channel = "BroadcastChannel" in window ? new BroadcastChannel("crystal-chaos") : null;
  const watchers = new Set();
  let pending = false;
  const notify = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      watchers.forEach((w) => w.cb(readAt(split(w.path))));
    }, 0);
  };
  channel?.addEventListener("message", notify);
  // Other tabs can receive the ping before the storage change itself has
  // reached them, so also refresh when the browser reports the change.
  window.addEventListener("storage", (e) => { if (!e.key || e.key.startsWith(PREFIX)) notify(); });

  const commit = (fn) => {
    fn();
    channel?.postMessage("changed");
    notify();
  };

  const disconnectWrites = new Map();
  window.addEventListener("pagehide", () => {
    if (!disconnectWrites.size) return;
    disconnectWrites.forEach((v, p) => writeAt(split(p), v));
    channel?.postMessage("changed");
  });

  return {
    kind: "local",
    uid,
    serverNow: () => Date.now(),
    async get(path) { return readAt(split(path)); },
    async set(path, value) { commit(() => writeAt(split(path), value)); },
    async update(path, values) {
      commit(() => {
        for (const [k, v] of Object.entries(values)) writeAt([...split(path), ...split(k)], v);
      });
    },
    async createIfAbsent(path, value) {
      if (readAt(split(path)) !== null) return false;
      commit(() => writeAt(split(path), value));
      return true;
    },
    watch(path, cb) {
      const w = { path, cb };
      watchers.add(w);
      queueMicrotask(() => cb(readAt(split(path))));
      return () => watchers.delete(w);
    },
    async onDisconnectSet(path, value) { disconnectWrites.set(path, value); },
    async cancelOnDisconnect(path) { disconnectWrites.delete(path); },
    onReconnect() {},
  };
}
