/**
 * Cached chain head for the getLogs range guard. Refreshed on an interval
 * with an eth_blockNumber call through the normal forwarding path (the
 * downstream cache answers that method, so it is close to free).
 */

const state = { latest: null, updatedAt: null, timer: null, errors: 0 };

function getLatestBlock() {
  return state.latest;
}

/** Test hook / manual set. */
function setLatestBlock(n) {
  state.latest = Number.isInteger(n) && n >= 0 ? n : null;
  state.updatedAt = state.latest === null ? null : new Date();
}

/**
 * @param fetchBlockNumber async () => hex string or number
 */
function startLatestBlockPolling(fetchBlockNumber, intervalMs = 12000) {
  if (state.timer) return;
  const tick = async () => {
    try {
      const raw = await fetchBlockNumber();
      const n = typeof raw === 'string' ? parseInt(raw, 16) : raw;
      if (!Number.isInteger(n) || n < 0) throw new Error(`bad block number ${raw}`);
      setLatestBlock(n);
      state.errors = 0;
    } catch (error) {
      state.errors++;
      if (state.errors === 1 || state.errors % 25 === 0) {
        console.error(`⚠️  latest block refresh failed (${state.errors}): ${error.message}`);
      }
    }
  };
  tick();
  state.timer = setInterval(tick, intervalMs);
  state.timer.unref?.();
}

function stopLatestBlockPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function getLatestBlockStatus() {
  return { latest: state.latest, updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null, errors: state.errors };
}

export { getLatestBlock, setLatestBlock, startLatestBlockPolling, stopLatestBlockPolling, getLatestBlockStatus };
