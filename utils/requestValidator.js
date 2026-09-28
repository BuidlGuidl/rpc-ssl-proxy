/**
 * Request Validator Middleware
 * 
 * Validates incoming JSON-RPC 2.0 requests before passing them to the downstream service.
 * This saves resources by rejecting invalid requests early in the pipeline.
 * 
 * Error handling strategy: FAIL-OPEN
 * If the validator itself encounters an unexpected error, we let the request through
 * rather than crashing the service. Better to let a potentially bad request through
 * than to break the entire proxy.
 */

import { logRejectedRequest } from './rejectLogger.js';
import { spliceIntoBatchResponse } from './batchMerge.js';
import { maxBatchLength, maxRequestBodySize } from '../config.js';

/**
 * Blocked RPC namespaces - these are dangerous or sensitive methods that should not be exposed
 * 
 * admin_    - Node management: add/remove peers, change settings, export chain data, stop node
 * personal_ - Account/wallet access: unlock accounts, sign transactions, list accounts with private keys
 * debug_    - Internal state inspection: memory dumps, stack traces, can leak sensitive node info
 * miner_    - Mining control: start/stop mining, set gas limits, set coinbase (PoW legacy but still dangerous)
 * engine_   - Consensus layer communication: could disrupt block production if abused
 * clique_   - PoA consensus control: propose/discard signers (deprecated in Geth 1.14 but may exist on nodes)
 * les_      - Light client server management
 */
const BLOCKED_NAMESPACES = [
  'admin_',
  'personal_',
  'debug_',
  'miner_',
  'engine_',
  'clique_',
  'les_'
];

/**
 * Check if a method belongs to a blocked namespace
 * @param {string} method - The RPC method name
 * @returns {string|null} - The blocked namespace if found, null otherwise
 */
function getBlockedNamespace(method) {
  try {
    if (typeof method !== 'string') return null;
    
    for (const namespace of BLOCKED_NAMESPACES) {
      if (method.startsWith(namespace)) {
        return namespace.slice(0, -1); // Remove trailing underscore for cleaner error message
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Send a JSON-RPC error response and log the rejection
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {number} code - JSON-RPC error code
 * @param {string} message - Error message
 * @param {*} id - Request ID (can be null)
 * @param {string} logReason - Reason for logging (may differ from user-facing message)
 */
function sendErrorAndLog(req, res, code, message, id, logReason) {
  // Fire-and-forget logging - never awaited, never throws
  logRejectedRequest(req, logReason);
  
  return res.status(200).send({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message
    }
  });
}

/**
 * Why one JSON-RPC item is unacceptable, or null if it's fine.
 * @returns {{ code: number, message: string, reason: string, namespace?: string } | null}
 */
function itemProblem(request) {
  const jsonrpc = request?.jsonrpc;
  const method = request?.method;
  const id = request?.id;

  if (!jsonrpc || jsonrpc !== "2.0" || !method || id === undefined) {
    const reason = [];
    if (!jsonrpc) reason.push('jsonrpc missing');
    else if (jsonrpc !== "2.0") reason.push('jsonrpc must be "2.0"');
    if (!method) reason.push('method missing');
    if (id === undefined) reason.push('id missing');
    const reasonStr = reason.join(", ");
    return { code: -32600, message: `Invalid Request: ${reasonStr}`, reason: reasonStr };
  }

  const blockedNamespace = getBlockedNamespace(method);
  if (blockedNamespace) {
    return {
      code: -32601,
      message: `Method not supported: The '${blockedNamespace}' namespace is not available on this endpoint`,
      reason: `blocked namespace '${blockedNamespace}' (method: ${method})`,
      namespace: blockedNamespace
    };
  }
  return null;
}

/**
 * Express error middleware for body-parser failures, mounted right after
 * bodyParser.json(). Answers JSON-RPC instead of Express's HTML error page:
 *   entity.too.large   → HTTP 413, -32600 "Request body too large (max <limit>)"
 *   entity.parse.failed → HTTP 400, -32700 "Parse error"
 *   any other body-parser error (unsupported charset/encoding, aborted stream) →
 *   its HTTP status, -32600 with the parser's message
 * Everything else is passed on. These never reach the handler, so they cost no
 * rate-limiter units; they are logged like the other rejections.
 */
function rejectBodyErrors(err, req, res, next) {
  try {
    if (!err || typeof err.type !== 'string' || typeof err.status !== 'number') {
      next(err);
      return;
    }
    let code, message;
    if (err.type === 'entity.too.large') {
      code = -32600; message = `Request body too large (max ${maxRequestBodySize})`;
    } else if (err.type === 'entity.parse.failed') {
      code = -32700; message = 'Parse error';
    } else {
      code = -32600; message = err.message || 'Invalid Request';
    }
    console.log(`‼️ Body rejected: ${err.type} (${err.status})`);
    logRejectedRequest(req, `body: ${err.type}`);
    res.status(err.status).json({ jsonrpc: "2.0", id: null, error: { code, message } });
  } catch (e) {
    try { console.error('[RequestValidator] rejectBodyErrors failed:', e?.message || e); } catch { /* ignore */ }
    next(err);
  }
}

/**
 * Express middleware to validate JSON-RPC 2.0 requests
 * Handles both single requests and batch requests (arrays)
 */
function validateRpcRequest(req, res, next) {
  try {
    // Skip validation for non-POST requests
    if (req.method !== 'POST') {
      next();
      return;
    }

    // Reject empty, null, or non-object bodies
    if (!req.body || typeof req.body !== 'object') {
      console.log("‼️ Invalid Request: empty or invalid body");
      return sendErrorAndLog(
        req, res,
        -32700,
        "Parse error: Invalid JSON or empty request body",
        null,
        "empty or invalid body"
      );
    }

    // Handle batch requests (arrays)
    if (Array.isArray(req.body)) {
      if (req.body.length === 0) {
        console.log("‼️ Invalid Request: empty batch array");
        return sendErrorAndLog(
          req, res,
          -32600,
          "Invalid Request: Batch request cannot be empty",
          null,
          "empty batch array"
        );
      }

      // Batch cap: the edge is the first layer to reject, so nothing downstream sees it
      if (req.body.length > maxBatchLength) {
        console.log(`‼️ Invalid Request: batch of ${req.body.length} exceeds max ${maxBatchLength}`);
        return sendErrorAndLog(
          req, res,
          -32600,
          `Batch too large (max ${maxBatchLength})`,
          req.body[0]?.id ?? null,
          `batch too large (${req.body.length} > ${maxBatchLength})`
        );
      }

      // Validate each item. Invalid items are answered per item, at their position
      // (JSON-RPC batch semantics; batch clients expect an array back). Valid items
      // are processed normally and the answers are merged back in order.
      const rejected = []; // { index, response }
      const remaining = [];
      const reasons = [];
      for (let i = 0; i < req.body.length; i++) {
        const request = req.body[i];
        const problem = itemProblem(request);
        if (!problem) {
          remaining.push(request);
          continue;
        }
        if (problem.code === -32601) {
          console.log(`🚫 Blocked namespace in batch item ${i}: ${problem.namespace} (method: ${request.method})`);
        } else {
          console.log(`‼️ Invalid Request in batch item ${i}: ${problem.reason}`);
          console.log("Request object:", request);
        }
        reasons.push(`batch[${i}]: ${problem.reason}`);
        rejected.push({
          index: i,
          response: { jsonrpc: "2.0", id: request?.id ?? null, error: { code: problem.code, message: problem.message } }
        });
      }

      if (rejected.length > 0) {
        logRejectedRequest(req, reasons.join('; '));
        if (remaining.length === 0) {
          return res.status(200).send(rejected.map(r => r.response));
        }
        req.body = remaining;
        spliceIntoBatchResponse(res, rejected);
      }

      // Mark as batch request for the handler
      req.isBatchRequest = true;
      next();
      return;
    }

    // Handle single requests
    const jsonrpc = req.body?.jsonrpc;
    const method = req.body?.method;
    const id = req.body?.id;
    
    // Basic structure validation
    if (!jsonrpc || jsonrpc !== "2.0" || !method || id === undefined) {
      let reason = [];
      if (!jsonrpc) reason.push('jsonrpc missing');
      else if (jsonrpc !== "2.0") reason.push('jsonrpc must be "2.0"');
      if (!method) reason.push('method missing');
      if (id === undefined) reason.push('id missing');
      
      const reasonStr = reason.join(", ");
      console.log("‼️ Invalid Request: " + reasonStr);
      console.log("Request object:", req.body);

      return sendErrorAndLog(
        req, res,
        -32600,
        "Invalid Request: " + reasonStr,
        id ?? null,
        reasonStr
      );
    }

    // Namespace validation
    const blockedNamespace = getBlockedNamespace(method);
    if (blockedNamespace) {
      console.log(`🚫 Blocked namespace: ${blockedNamespace} (method: ${method})`);
      return sendErrorAndLog(
        req, res,
        -32601,
        `Method not supported: The '${blockedNamespace}' namespace is not available on this endpoint`,
        id,
        `blocked namespace '${blockedNamespace}' (method: ${method})`
      );
    }
    
    next();
  } catch (err) {
    // FAIL-OPEN: If validation itself fails, log and let the request through
    // This ensures the proxy never crashes due to validation bugs
    try {
      console.error('[RequestValidator] Unexpected error in validation, failing open:', err?.message || err);
    } catch {
      // Even console.error failed - continue silently
    }
    next();
  }
}

export { validateRpcRequest, rejectBodyErrors, BLOCKED_NAMESPACES };
