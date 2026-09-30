/**
 * The edge's own JSON-RPC error answers, in one place so the single-request and batch
 * paths can't drift. Every builder returns a complete JSON-RPC error object; the caller
 * picks the HTTP status. Nothing here may carry internal hosts, ports or provider URLs:
 * those go to the log, not to the answer.
 */

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/** -32601: the method exists but this endpoint doesn't offer it to this caller (anonymous getLogs). */
function methodUnavailableError(id, method) {
  return jsonRpcError(id, -32601, `${method} is not available on this endpoint`);
}

/**
 * -32005 for a tripped rate limit, naming the limit and when to retry.
 * @param {object} limit - from checkRateLimit(): { scope: 'ip'|'origin', window: 'hour'|'day',
 *   limit: number, retryAfter: seconds, origin?: string }
 */
function rateLimitError(id, limit) {
  const units = Number(limit?.limit);
  const who = limit?.scope === 'origin'
    ? `origin ${limit.origin || 'unknown'}`
    : 'requests without an Origin header';
  const retryAfter = Number.isFinite(limit?.retryAfter) ? Math.max(1, Math.round(limit.retryAfter)) : null;
  const message = Number.isFinite(units) && limit?.window
    ? `Rate limit exceeded: ${units.toLocaleString('en-US')} request units per ${limit.window} for ${who}`
      + (retryAfter !== null ? `; retry in ${retryAfter} s` : '')
    : 'Rate limit exceeded.';
  return jsonRpcError(id, -32005, message, retryAfter !== null ? { retryAfter } : undefined);
}

/** -32005 with no detail: what blacklisted IPs get, on purpose (indistinguishable from a limit). */
function plainRateLimitError(id) {
  return jsonRpcError(id, -32005, 'Rate limit exceeded.');
}

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE']);

function isJsonRpcErrorBody(body) {
  const one = (b) => b && typeof b === 'object' && !Array.isArray(b) && b.jsonrpc === '2.0' && b.error && typeof b.error === 'object';
  if (Array.isArray(body)) return body.length > 0 && body.every(one);
  return one(body);
}

/** The JSON-RPC error body an upstream answered with (any HTTP status), or null. */
function upstreamJsonRpcBody(error) {
  const body = error?.response?.data;
  return isJsonRpcErrorBody(body) ? body : null;
}

/**
 * Turn an axios failure into the answer for the caller.
 * @param {*} id - JSON-RPC id to echo
 * @param {Error} error - the axios error
 * @param {object} opts - { timeoutMs, what }: `what` names the request in the timeout
 *   text ('upstream' for normal requests, 'eth_getLogs' for the getLogs path)
 * @returns {{ body: object, kind: string }} kind: 'passthrough'|'timeout'|'unavailable'|'too-large'|'failed'
 */
function upstreamFailureAnswer(id, error, { timeoutMs, what = 'upstream' } = {}) {
  const passthrough = upstreamJsonRpcBody(error);
  if (passthrough) return { body: passthrough, kind: 'passthrough' };

  const code = error?.code;
  const message = String(error?.message || '');
  if (TIMEOUT_CODES.has(code) || /timeout|aborted/i.test(message)) {
    const seconds = Number.isFinite(timeoutMs) ? Math.round(timeoutMs / 1000) : null;
    return {
      kind: 'timeout',
      body: jsonRpcError(id, -32603, `Internal error: ${what} timed out${seconds !== null ? ` after ${seconds} s` : ''}`)
    };
  }
  if (/maxContentLength|maxBodyLength/i.test(message)) {
    return { kind: 'too-large', body: jsonRpcError(id, -32603, 'Internal error: response too large') };
  }
  if (UNREACHABLE_CODES.has(code) || /socket hang up/i.test(message)) {
    return { kind: 'unavailable', body: jsonRpcError(id, -32603, 'Internal error: upstream unavailable') };
  }
  return { kind: 'failed', body: jsonRpcError(id, -32603, 'Internal error: upstream request failed') };
}

export {
  jsonRpcError,
  methodUnavailableError,
  rateLimitError,
  plainRateLimitError,
  upstreamJsonRpcBody,
  upstreamFailureAnswer
};
