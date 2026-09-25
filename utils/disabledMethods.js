/**
 * Reject disabled methods (bg-rpc-docs plan, D15) with HTTP 200 and
 * -32601 "<method> is not supported on this endpoint; use eth_getLogs".
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

import { disabledMethods } from '../config.js';
import { logRejectedRequest } from './rejectLogger.js';

const disabledSet = new Set(disabledMethods);

function disabledError(item) {
  return {
    jsonrpc: "2.0",
    id: item?.id ?? null,
    error: {
      code: -32601,
      message: `${item.method} is not supported on this endpoint; use eth_getLogs`
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
      if (disabledSet.has(req.body.method)) {
        console.log(`🚫 Disabled method ${req.body.method} (D15)`);
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
      if (disabledSet.has(item?.method)) {
        disabled.push({ index, response: disabledError(item) });
      } else {
        remaining.push(item);
      }
    });

    if (disabled.length === 0) {
      next();
      return;
    }

    const names = disabled.map(d => d.response.error.message.split(' ')[0]).join(',');
    console.log(`🚫 Disabled method(s) in batch: ${names} (${disabled.length} of ${req.body.length} items, D15)`);
    logRejectedRequest(req, `disabled method(s) in batch: ${names}`);

    if (remaining.length === 0) {
      res.status(200).json(disabled.map(d => d.response));
      return;
    }

    // Process the rest normally, then splice the errors back in at their positions.
    req.body = remaining;
    const originalSend = res.send;
    let mergedOnce = false; // res.send(object) re-enters res.send(string) via res.json
    res.send = function (body) {
      if (mergedOnce) return originalSend.call(this, body);
      mergedOnce = true;
      let merged = body;
      try {
        let answers = body;
        if (typeof body === 'string') {
          try { answers = JSON.parse(body); } catch { answers = body; }
        }
        if (Array.isArray(answers)) {
          merged = answers.slice();
          for (const d of disabled) merged.splice(d.index, 0, d.response);
          if (typeof body === 'string') merged = JSON.stringify(merged);
        }
        // A non-array body (a single error object for the whole batch) is sent as-is.
      } catch (err) {
        console.error('[disabledMethods] merge failed, sending upstream body unchanged:', err?.message || err);
        merged = body;
      }
      return originalSend.call(this, merged);
    };
    next();
  } catch (err) {
    // FAIL-OPEN like the validator: never take the proxy down over this check.
    try { console.error('[disabledMethods] unexpected error, failing open:', err?.message || err); } catch { /* ignore */ }
    next();
  }
}

export { rejectDisabledMethods };
