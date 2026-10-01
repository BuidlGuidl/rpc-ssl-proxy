/**
 * Reject disabled methods with HTTP 200 and -32601:
 *   - filter methods (bg-rpc-docs plan, D15, config.js disabledMethods):
 *     "<method> is not supported on this endpoint; use eth_getLogs"
 *   - subscription methods (config.js wsOnlyMethods): the message listed there
 *
 * Runs right after request validation and before everything else in the POST
 * pipeline (blacklist, getLogs policy, rate limiter, forwarding), so a disabled
 * method never costs a key check, a rate-limiter unit, a getLogs concurrency slot
 * or an upstream request.
 *
 * Batches: the disabled items are answered here and removed from req.body; the rest
 * of the batch is processed normally, and the answers are merged back into the
 * response array at their original positions. If every item is disabled, the array
 * of errors is sent directly.
 */

import { disabledMethods, wsOnlyMethods } from '../config.js';
import { logRejectedRequest } from './rejectLogger.js';
import { spliceIntoBatchResponse } from './batchMerge.js';

// method → the -32601 message it is answered with
const refusals = new Map([
  ...disabledMethods.map(m => [m, `${m} is not supported on this endpoint; use eth_getLogs`]),
  ...Object.entries(wsOnlyMethods)
]);

function disabledError(item) {
  return {
    jsonrpc: "2.0",
    id: item?.id ?? null,
    error: {
      code: -32601,
      message: refusals.get(item.method)
    }
  };
}

function rejectDisabledMethods(req, res, next) {
  try {
    if (req.method !== 'POST' || !req.body) {
      next();
      return;
    }

    // Single request
    if (!Array.isArray(req.body)) {
      if (refusals.has(req.body.method)) {
        console.log(`🚫 Disabled method ${req.body.method}`);
        logRejectedRequest(req, `disabled method ${req.body.method}`);
        res.status(200).json(disabledError(req.body));
        return;
      }
      next();
      return;
    }

    // Batch
    const disabled = []; // { index, response }
    const remaining = [];
    req.body.forEach((item, index) => {
      if (refusals.has(item?.method)) {
        disabled.push({ index, method: item.method, response: disabledError(item) });
      } else {
        remaining.push(item);
      }
    });

    if (disabled.length === 0) {
      next();
      return;
    }

    const names = disabled.map(d => d.method).join(',');
    console.log(`🚫 Disabled method(s) in batch: ${names} (${disabled.length} of ${req.body.length} items)`);
    logRejectedRequest(req, `disabled method(s) in batch: ${names}`);

    if (remaining.length === 0) {
      res.status(200).json(disabled.map(d => d.response));
      return;
    }

    // Process the rest normally, then splice the errors back in at their positions
    // (utils/batchMerge.js; a whole-batch error object is sent as-is).
    req.body = remaining;
    spliceIntoBatchResponse(res, disabled, remaining);
    next();
  } catch (err) {
    // FAIL-OPEN like the validator: never take the proxy down over this check.
    try { console.error('[disabledMethods] unexpected error, failing open:', err?.message || err); } catch { /* ignore */ }
    next();
  }
}

export { rejectDisabledMethods, disabledError };
