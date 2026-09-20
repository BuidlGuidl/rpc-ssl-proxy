/**
 * API key store.
 *
 * Keys are minted by rpc-token-manager into the Firestore collection
 * `rpcKeys<FIREBASE_COLLECTION>` (doc id = key, fields: keyValue,
 * ethereumAddress, createdAt). This module mirrors that collection into
 * memory on an interval so the request path never touches Firestore.
 *
 * A key is valid when its doc exists and does not carry `revoked: true`.
 * Deleting the doc (what the token manager's delete route does) revokes it.
 */

import { apiKeyRefreshInterval } from '../config.js';

const KEY_PATTERN = /^[a-f0-9]{16,64}$/i;

const state = {
  keys: new Map(),        // key -> { owner, createdAt }
  ready: false,           // true once one load has succeeded
  lastRefresh: null,
  lastError: null,
  refreshErrors: 0,
  timer: null,
};

/** Replace the whole key set (used by the poller and by tests). */
function setApiKeys(entries) {
  const next = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string') continue;
    const key = entry.key.trim().toLowerCase();
    if (!KEY_PATTERN.test(key)) continue;
    if (entry.revoked === true) continue;
    next.set(key, { owner: entry.owner || null, createdAt: entry.createdAt || null });
  }
  state.keys = next;
  state.ready = true;
  state.lastRefresh = new Date();
}

function isApiKeyStoreReady() {
  return state.ready;
}

/** Well-formed key string or null. Never throws. */
function normalizeApiKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return KEY_PATTERN.test(key) ? key : null;
}

/** Pull the key from the URL (`/v1/<key>`) or the `X-Api-Key` header. */
function extractApiKey(req) {
  try {
    const fromPath = req?.params?.key;
    if (typeof fromPath === 'string' && fromPath.length > 0) return fromPath;
    const fromHeader = req?.headers?.['x-api-key'];
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the key on a request.
 *   { status: 'none' }                       no key presented
 *   { status: 'invalid', reason }            key presented but not accepted
 *   { status: 'valid', key, owner }          key accepted
 */
function resolveApiKey(req) {
  const raw = extractApiKey(req);
  if (raw === null) return { status: 'none' };
  const key = normalizeApiKey(raw);
  if (key === null) return { status: 'invalid', reason: 'malformed key' };
  if (!state.ready) return { status: 'invalid', reason: 'key store not loaded' };
  const entry = state.keys.get(key);
  if (!entry) return { status: 'invalid', reason: 'unknown or revoked key' };
  return { status: 'valid', key, owner: entry.owner };
}

/** Load keys from Firestore once. Exported so a script can run it by hand. */
async function loadApiKeysFromFirestore() {
  const { db } = await import('./firebaseClient.js');
  const collectionName = `rpcKeys${process.env.FIREBASE_COLLECTION || ''}`;
  const snapshot = await db.collection(collectionName).get();
  const entries = [];
  snapshot.forEach(doc => {
    const data = doc.data() || {};
    entries.push({
      key: data.keyValue || doc.id,
      owner: data.ethereumAddress || null,
      createdAt: data.createdAt || null,
      revoked: data.revoked === true,
    });
  });
  setApiKeys(entries);
  return entries.length;
}

/**
 * Start mirroring Firestore into memory. A failed refresh keeps the last
 * good set; if no load has ever succeeded, every key is treated as invalid.
 */
function startApiKeyPolling(intervalSeconds = apiKeyRefreshInterval) {
  if (state.timer) return;
  const tick = async () => {
    try {
      const n = await loadApiKeysFromFirestore();
      if (state.refreshErrors > 0) console.log(`🔑 API key refresh recovered (${n} keys)`);
      state.refreshErrors = 0;
      state.lastError = null;
    } catch (error) {
      state.refreshErrors++;
      state.lastError = error.message;
      console.error(`❌ API key refresh failed (${state.refreshErrors}): ${error.message}`);
      if (!state.ready) console.error('   No key set loaded yet - all API keys are being rejected');
    }
  };
  tick();
  state.timer = setInterval(tick, intervalSeconds * 1000);
  state.timer.unref?.();
  console.log(`🔑 API key store polling Firestore every ${intervalSeconds}s`);
}

function stopApiKeyPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** For /status. Counts only, never the keys themselves. */
function getApiKeyStoreStatus() {
  return {
    ready: state.ready,
    keyCount: state.keys.size,
    lastRefresh: state.lastRefresh ? state.lastRefresh.toISOString() : null,
    lastError: state.lastError,
    refreshErrors: state.refreshErrors,
  };
}

export {
  setApiKeys,
  isApiKeyStoreReady,
  normalizeApiKey,
  extractApiKey,
  resolveApiKey,
  loadApiKeysFromFirestore,
  startApiKeyPolling,
  stopApiKeyPolling,
  getApiKeyStoreStatus,
};
