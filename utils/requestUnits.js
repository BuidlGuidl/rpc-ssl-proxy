/**
 * Shared request cost table (units per JSON-RPC request).
 *
 * The same units are used by the RPC pool for load balancing and by API-key
 * metering, so the numbers here must match those exactly. The rate limits in
 * config.js are denominated in these units.
 *
 *   eth_getLogs            1 + ceil(blocks / 1000); blocks = the resolved range
 *                          (toBlock - fromBlock + 1, capped at 10,000; a blockHash
 *                          filter counts as 1 block)   → 1–1,000 blocks = 2, 10,000 = 11
 *   eth_getBlockReceipts   2
 *   eth_getBlockByNumber   2
 *   eth_getBlockByHash     2
 *   eth_feeHistory         1 + ceil(blockCount / 100); blockCount = params[0] (number
 *                          or hex string), capped at 1,024; missing/unreadable = 1
 *                          → 4 = 2, 1,024 = 12
 *   eth_getProof           1 + ceil(storageKeys / 10); storageKeys = params[1].length
 *                          (not an array = 0)   → 0 keys = 1, 1 = 2, 1,000 = 101
 *   everything else        1
 *   a batch                the sum of its items (summed by the caller)
 */

const GETLOGS_MAX_BLOCKS = 10000;
const FEE_HISTORY_MAX_BLOCKS = 1024;

// Non-negative integer from a JSON-RPC quantity (number, hex string or decimal
// string); null when unreadable.
function toCount(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
      const n = Number.parseInt(s, 16);
      return Number.isSafeInteger(n) ? n : null;
    }
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return Number.isSafeInteger(n) ? n : null;
    }
  }
  return null;
}

/**
 * Units one JSON-RPC request counts for.
 *
 * @param {object} request - one JSON-RPC item ({ method, params, ... })
 * @param {number} [getLogsBlockCount] - for eth_getLogs, the block count already
 *   resolved by validateGetLogs() (1 for a blockHash filter). The range is not
 *   re-parsed here; anything unusable counts as 1 block.
 * @returns {number} units (always >= 1)
 */
function requestUnits(request, getLogsBlockCount) {
  const method = request?.method;
  if (typeof method !== 'string') return 1;
  const params = Array.isArray(request?.params) ? request.params : [];

  switch (method) {
    case 'eth_getLogs': {
      const known = Number.isInteger(getLogsBlockCount) && getLogsBlockCount > 0;
      const blocks = Math.min(known ? getLogsBlockCount : 1, GETLOGS_MAX_BLOCKS);
      return 1 + Math.ceil(blocks / 1000);
    }
    case 'eth_getBlockReceipts':
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return 2;
    case 'eth_feeHistory': {
      const blockCount = Math.min(toCount(params[0]) ?? 1, FEE_HISTORY_MAX_BLOCKS);
      return 1 + Math.ceil(blockCount / 100);
    }
    case 'eth_getProof': {
      const storageKeys = Array.isArray(params[1]) ? params[1].length : 0;
      return 1 + Math.ceil(storageKeys / 10);
    }
    default:
      return 1;
  }
}

export { requestUnits };
