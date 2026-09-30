import https from "https";
import express from "express";
import axios from "axios";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import compression from "compression";
import zlib from "zlib";
import { fileURLToPath } from 'url';
import ethers from "ethers";
import sslRootCas from "ssl-root-cas";
import dotenv from "dotenv";
import { updateUrlCountMap, updateIpCountMap, startBackgroundTasks } from './utils/backgroundTasks.js';
import { CircuitBreaker } from './utils/circuitBreaker.js';
import { checkRateLimit, getRateLimitStatus, startRateLimitPolling, getSecondsUntilNextHour } from './utils/rateLimiter.js';
import { perItem, jsonRpcError, methodUnavailableError, rateLimitError, plainRateLimitError, upstreamJsonRpcBody, upstreamFailureAnswer } from './utils/errorMessages.js';
import { validateRpcRequest, rejectBodyErrors } from './utils/requestValidator.js';
import { rejectDisabledMethods } from './utils/disabledMethods.js';
import { isIPBlacklisted, startWatchingBlacklist, getBlacklistStatus } from './utils/ipBlacklist.js';
import { requireAdminKey } from './utils/adminAuth.js';
import {
  forwardedHeaders, maxRequestBodySize,
  getLogsMethods, getLogsGlobalConcurrency, getLogsMaxPerBatch, getLogsUpstreamTimeoutMs, getLogsMaxResponseBytes
} from './config.js';
import { redactUrl } from './utils/redactUrl.js';
import { validateGetLogs, startGetLogsPollers, getGetLogsState } from './utils/getLogsPolicy.js';
import { requestUnits } from './utils/requestUnits.js';
import { spliceIntoBatchResponse } from './utils/batchMerge.js';
import { internalAgent } from './utils/internalAgent.js';

var app = express();
https.globalAgent.options.ca = sslRootCas.create();
dotenv.config();
// TLS verification is on for the whole process. The internal hops use
// utils/internalAgent.js (see TARGET_CA_FILE there), the fallback uses fallbackAgent.

// Nothing sits in front of this service, so forwarding headers are caller-supplied
// and unverifiable. Keeping this false makes req.ip the address observed on the socket.
// If a CDN or load balancer is added later, set this to that proxy's CIDR ranges.
app.set('trust proxy', false);

const targetUrl = process.env.TARGET_URL;
const fallbackUrl = process.env.FALLBACK_URL;

console.log(`🔧 RPC Proxy Configuration:`);
console.log(`   Primary URL: ${targetUrl || 'NOT SET'}`);
console.log(`   Fallback URL: ${redactUrl(fallbackUrl)}`);

// Keyless getLogs switch (plan D10, Phase 4 policy pass; owner decision 2026-09-30:
// serve getLogs to everyone now, API keys are a later project). On: eth_getLogs takes
// the policy path below without an API key. Off: every eth_getLogs item is answered
// -32601. GETLOGS_KEYLESS_STAGE is accepted as an alias for existing .env files.
const isOn = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
const getLogsKeyless = isOn(process.env.GETLOGS_KEYLESS) || isOn(process.env.GETLOGS_KEYLESS_STAGE);
if (getLogsKeyless) {
  console.log('🪵 getLogs is served without an API key (GETLOGS_KEYLESS)');
} else {
  console.log('🪵 eth_getLogs is blocked (-32601); set GETLOGS_KEYLESS=true to serve it');
}

// Initialize circuit breaker
const circuitBreaker = new CircuitBreaker({
  primaryUrl: targetUrl,
  fallbackUrl: fallbackUrl,
  failureThreshold: 2, // Switch to fallback after 2 consecutive failures
  resetTimeout: 60000, // Try primary again after 60 seconds
  requestTimeout: 15000 // 15 second timeout
});

// Edge → client compression (bg-rpc-docs plan, Phase 1e). Size-selected: responses
// under 1 KB are sent as-is, so eth_call / eth_blockNumber never touch zlib. Level 1
// for gzip/deflate and brotli quality 1 (the package default, q4, costs ~3× the CPU
// for a modest size gain on JSON-RPC bodies). Clients that don't send Accept-Encoding
// get plain JSON.
app.use(compression({
  threshold: 1024,
  level: zlib.constants.Z_BEST_SPEED,
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } }
}));
// CORS first, so every answer below (including body errors) carries the headers.
app.use(cors());
// Parse the body as JSON whatever the Content-Type says (curl -d sends
// x-www-form-urlencoded, browser fetch with a string body sends text/plain), capped
// at maxRequestBodySize; parser failures are answered as JSON-RPC by rejectBodyErrors.
app.use(bodyParser.json({ limit: maxRequestBodySize, type: () => true }));
app.use(rejectBodyErrors);

// Validate RPC requests early to avoid forwarding invalid requests to downstream service
app.use(validateRpcRequest);

// Filter ("ticket") methods are off (D15): answered here, before anything else
app.use(rejectDisabledMethods);

var last = "";

var memcache = {};
var methods = {};
var methodsByReferer = {};

// Helper function to normalize IPv4-mapped IPv6 addresses
function normalizeIP(ip) {
  if (!ip) return 'unknown';
  // Ensure ip is a string
  if (typeof ip !== 'string') {
    console.warn(`normalizeIP received non-string: ${typeof ip}`);
    return 'unknown';
  }
  // Strip IPv4-mapped IPv6 prefix (::ffff:)
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}

// Helper function to safely extract client IP
// Deliberately ignores X-Forwarded-For and CDN headers: a peer must complete a TCP
// and TLS handshake to reach this code, so the socket address cannot be forged,
// while those headers are free-form caller input. Rate limit counters are only
// meaningful when keyed on an identity the caller cannot mint at will.
function getClientIP(req) {
  try {
    return normalizeIP(req.ip || req.socket?.remoteAddress || 'unknown');
  } catch (error) {
    // If anything goes wrong, return 'unknown' to avoid breaking the application
    console.error('Error extracting client IP:', error);
    return 'unknown';
  }
}

// Helper function to safely extract origin from request
function getOrigin(req) {
  try {
    // Only return the actual origin header, no fallbacks
    return req.headers.origin || 'unknown';
  } catch (error) {
    // If anything goes wrong, return 'unknown' to avoid breaking the application
    return 'unknown';
  }
}

// Build the header set for the next hop. Only the allowlisted caller headers cross
// (see forwardedHeaders in config.js); Content-Type is always ours because the body
// is re-serialized from req.body. When clientIP is given (requests to TARGET_URL,
// bg-rpc-proxy, which logs it), X-Client-IP carries the caller's socket address as
// seen by this edge: the same value the rate limiter uses (getClientIP). A caller's
// own X-Client-IP is never forwarded (it isn't in the allowlist). Calls without
// clientIP (the fallback provider) never get the header.
function upstreamHeaders(clientHeaders, clientIP) {
  const headers = { "Content-Type": "application/json" };
  for (const name of forwardedHeaders) {
    const value = clientHeaders?.[name];
    if (typeof value === 'string' && value !== '') {
      headers[name] = value;
    }
  }
  if (typeof clientIP === 'string' && clientIP !== '') {
    headers["X-Client-IP"] = clientIP;
  }
  return headers;
}

// JSON-RPC id to echo in an error response: the request's id, or the first item's
// id for a batch (the convention every other error path here already uses).
function requestIdOf(body) {
  try {
    if (Array.isArray(body)) return body[0]?.id ?? null;
    return body?.id ?? null;
  } catch {
    return null;
  }
}

// The fallback is a public provider and its URL carries the API key: its own agent,
// verifying, never shared with the internal hops.
const fallbackAgent = new https.Agent({ rejectUnauthorized: true });

// Helper function to make fallback requests with consistent settings
async function makeFallbackRequest(data, headers) {
  if (!fallbackUrl || fallbackUrl.trim() === '') {
    throw new Error("No fallback URL configured");
  }
  
  const cleanHeaders = {
    "Content-Type": "application/json",
    "User-Agent": headers["user-agent"] || "RPC-Proxy"
  };
  
  return axios.post(fallbackUrl, data, {
    headers: cleanHeaders,
    timeout: 15000,
    maxRedirects: 0,
    httpsAgent: fallbackAgent
  });
}

// getLogs-path in-flight counter (edge-wide cap, D8).
let getLogsInFlight = 0;

// Forward a getLogs-path request to bg-rpc-proxy. Differences from
// makePrimaryRequest: its own (longer) timeout, a response size cap, and it never
// touches the circuit breaker or the fallback: a getLogs failure is returned to the
// caller as JSON-RPC, never retried on a paid provider (plan 4c step 5).
async function makeGetLogsRequest(data, headers, clientIP) {
  return axios.post(targetUrl, data, {
    headers: upstreamHeaders(headers, clientIP),
    httpsAgent: internalAgent,
    timeout: getLogsUpstreamTimeoutMs,
    maxContentLength: getLogsMaxResponseBytes,
    maxBodyLength: getLogsMaxResponseBytes
  });
}

// Forward one getLogs-path item (or the non-getLogs remainder of a batch) and turn
// the outcome into an answer: the upstream body, or a -32603 with the given id.
async function forwardGetLogsPath(data, headers, clientIP, errorId) {
  const startedAt = Date.now();
  try {
    const response = await makeGetLogsRequest(data, headers, clientIP);
    return { ok: true, data: response.data, ms: Date.now() - startedAt, bytes: response.headers?.['content-length'] ?? '?' };
  } catch (error) {
    // A JSON-RPC body from bg-rpc-proxy (any HTTP status) is passed through; otherwise
    // the failure is classified (timeout, unavailable, too large, other). Detail to the log.
    const answer = upstreamFailureAnswer(errorId, error, { timeoutMs: getLogsUpstreamTimeoutMs, what: 'eth_getLogs' });
    console.log(`🪵 getLogs upstream error after ${Date.now() - startedAt} ms: ${error.code || 'no code'} ${error.message} (HTTP ${error.response?.status ?? '-'}) → ${answer.kind}`);
    return { ok: false, ms: Date.now() - startedAt, data: answer.body };
  }
}

// Helper function to make primary requests with circuit breaker
async function makePrimaryRequest(method, url, data, headers, clientIP, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const config = {
      method,
      url,
      headers: upstreamHeaders(headers, clientIP),
      httpsAgent: internalAgent,
      signal: controller.signal,
      timeout
    };
    
    if (data && method.toLowerCase() !== 'get') {
      config.data = data;
    }
    
    const response = await axios(config);
    clearTimeout(timeoutId);
    
    // Only count as success for POST requests (main RPC functionality)
    if (method.toLowerCase() === 'post') {
      circuitBreaker.onSuccess();
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    // Only count as failure for POST requests (main RPC functionality)
    if (method.toLowerCase() === 'post') {
      circuitBreaker.onFailure(error);
    }
    
    throw error;
  }
}

app.post("/", async (req, res) => {
  const clientIP = getClientIP(req);
  const origin = req.headers.origin;
  
  // Check IP blacklist FIRST before any other processing
  if (isIPBlacklisted(clientIP)) {
    console.log(`🚫 Blacklisted IP blocked: ${clientIP}`);
    
    // Extract request ID from body (handle both single and batch requests)
    let requestId = null;
    if (req.body) {
      if (Array.isArray(req.body) && req.body.length > 0) {
        requestId = req.body[0]?.id ?? null;
      } else {
        requestId = req.body?.id ?? null;
      }
    }
    
    // Blacklisted IPs get the plain rate-limit message on purpose (indistinguishable
    // from a limit from the outside).
    res.status(429)
      .set('Retry-After', '3600') // 1 hour
      .json(perItem(req.body, plainRateLimitError(requestId)));
    return;
  }
  
  // getLogs and the filter methods (D9). Without the stage switch they are not offered
  // to callers without a key: -32601 per item (not a rate limit, so HTTP 200, no
  // Retry-After, no units); the rest of a batch is processed normally. With the switch
  // they take the policy path below, after the rate limiter.
  let heavyItems = (Array.isArray(req.body) ? req.body : [req.body]).filter(r => getLogsMethods.includes(r?.method));
  if (heavyItems.length > 0 && !getLogsKeyless) {
    console.log(`🚫 Blocked ${heavyItems.map(r => r.method).join(',')} from ${clientIP}`);
    if (!Array.isArray(req.body)) {
      res.status(200).json(methodUnavailableError(req.body?.id, req.body.method));
      return;
    }
    const blocked = heavyItems.map(item => ({ index: req.body.indexOf(item), response: methodUnavailableError(item?.id, item.method) }));
    const remaining = req.body.filter(item => !heavyItems.includes(item));
    if (remaining.length === 0) {
      res.status(200).json(blocked.map(b => b.response));
      return;
    }
    req.body = remaining;
    spliceIntoBatchResponse(res, blocked, remaining);
    heavyItems = [];
  }

  // Check rate limit before any other processing
  const rateLimitResult = checkRateLimit(clientIP, origin);
  if (rateLimitResult.limited) {
    console.log(`🚫 Rate limited: ${rateLimitResult.reason}`);
    
    // Extract request ID from body (handle both single and batch requests)
    let requestId = null;
    if (req.body) {
      if (Array.isArray(req.body) && req.body.length > 0) {
        requestId = req.body[0]?.id ?? null;
      } else {
        requestId = req.body?.id ?? null;
      }
    }
    
    res.status(429)
      .set('Retry-After', String(rateLimitResult.retryAfter || getSecondsUntilNextHour()))
      .json(perItem(req.body, rateLimitError(requestId, rateLimitResult)));
    return;
  }
  
  // ---- getLogs policy path (plan 4c/4d, policy pass) ----------------------------
  if (heavyItems.length > 0) {
    // 1. validate every heavy item. A rejected item is answered per item (its -32602 /
    // -32603 at its position, JSON-RPC batch semantics); the rest of the batch is
    // forwarded and merged back in order (utils/batchMerge.js). Rejected items cost no
    // rate-limiter units and no in-flight slot. At most getLogsMaxPerBatch eth_getLogs
    // items per batch: the ones past the cap are rejected before validation. The
    // resolved block count per accepted item is kept for the unit count below.
    const isBatch = Array.isArray(req.body);
    const heavyBlockCounts = new Map();
    const rejected = []; // { index, response } relative to req.body as it is now
    let getLogsSeen = 0;
    for (const item of heavyItems) {
      if (item.method === 'eth_getLogs' && ++getLogsSeen > getLogsMaxPerBatch) {
        console.log(`🪵 getLogs rejected (batch cap) from ${clientIP}: item ${getLogsSeen} of ${heavyItems.length}`);
        rejected.push({
          index: req.body.indexOf(item),
          response: jsonRpcError(item.id, -32602, `At most ${getLogsMaxPerBatch} eth_getLogs per batch; send the rest in another request`)
        });
        continue;
      }
      const verdict = validateGetLogs(item);
      if (verdict.ok) {
        heavyBlockCounts.set(item, verdict.blockCount);
        continue;
      }
      console.log(`🪵 getLogs rejected (${item.method}) from ${clientIP}: ${verdict.error.code} ${verdict.error.message}`);
      rejected.push({
        index: isBatch ? req.body.indexOf(item) : 0,
        response: jsonRpcError(item.id, verdict.error.code, verdict.error.message)
      });
    }

    if (rejected.length > 0) {
      if (!isBatch) {
        res.status(200).json(rejected[0].response);
        return;
      }
      const remaining = req.body.filter(item => !rejected.some(r => req.body[r.index] === item));
      if (remaining.length === 0) {
        res.status(200).json(rejected.map(r => r.response));
        return;
      }
      req.body = remaining;
      spliceIntoBatchResponse(res, rejected, remaining);
    }

    // No accepted getLogs item left: the rest of the batch takes the normal path below.
    if (heavyBlockCounts.size > 0) {
      // 2. edge-wide capacity: one slot per accepted getLogs item, all or nothing
      const slots = heavyBlockCounts.size;
      if (getLogsInFlight + slots > getLogsGlobalConcurrency) {
        console.log(`🪵 getLogs capacity: ${getLogsInFlight} in flight + ${slots} requested > ${getLogsGlobalConcurrency}, rejecting request from ${clientIP}`);
        res.status(429)
          .set('Retry-After', '2')
          .json(perItem(req.body, jsonRpcError(requestIdOf(req.body), -32005, 'getLogs capacity exhausted at the edge, retry shortly')));
        return;
      }

      // 3. forward: own timeout, size cap, no breaker, no fallback.
      if (!isBatch) {
        // Single request: one slot, one upstream request, the answer as-is.
        getLogsInFlight++;
        let outcome;
        try {
          outcome = await forwardGetLogsPath(req.body, req.headers, clientIP, requestIdOf(req.body));
        } finally {
          getLogsInFlight--;
        }
        res.status(200).send(outcome.data);
        if (outcome.ok) {
          console.log(`🪵 getLogs served (${req.body.method}) from ${clientIP} in ${outcome.ms} ms, upstream ${outcome.bytes} bytes`);
          const requestCount = requestUnits(req.body, heavyBlockCounts.get(req.body));
          updateIpCountMap(clientIP, req.headers.origin, requestCount);
          if (req.headers.origin) updateUrlCountMap(req.headers.origin, requestCount);
        }
        return;
      }

      // Batch: each accepted getLogs item goes upstream as its own request, in
      // parallel (bg-rpc-proxy would run a batch's items one after another, so one
      // batch could outlast every timeout); the non-getLogs items go as one batch.
      // Answers are merged back in the batch's order; a failed item gets its own
      // -32603 and the others keep their answers.
      const items = req.body;
      const answers = new Array(items.length);
      const restIndexes = [];
      items.forEach((item, i) => { if (!heavyBlockCounts.has(item)) restIndexes.push(i); });
      getLogsInFlight += slots;
      const startedAt = Date.now();
      let servedUnits = 0;
      const jobs = [];
      items.forEach((item, i) => {
        if (!heavyBlockCounts.has(item)) return;
        jobs.push(forwardGetLogsPath(item, req.headers, clientIP, item?.id ?? null).then(outcome => {
          answers[i] = outcome.data;
          if (outcome.ok) servedUnits += requestUnits(item, heavyBlockCounts.get(item));
          console.log(`🪵 getLogs batch item ${i} ${outcome.ok ? 'served' : 'failed'} from ${clientIP} in ${outcome.ms} ms, upstream ${outcome.bytes ?? '-'} bytes`);
        }).finally(() => { getLogsInFlight--; }));
      });
      if (restIndexes.length > 0) {
        const rest = restIndexes.map(i => items[i]);
        jobs.push(forwardGetLogsPath(rest, req.headers, clientIP, null).then(outcome => {
          // A single error object from upstream (its own rate limit, a passed-through
          // -32600, the classified failure) becomes each item's error with its own id;
          // arrays are matched by position, then by id; anything still unmatched gets
          // the generic -32603. Units only for answers without an error.
          const restData = perItem(rest, outcome.data);
          const upstreamAnswers = Array.isArray(restData) ? restData : null;
          const byPosition = upstreamAnswers && upstreamAnswers.length === rest.length;
          const byId = upstreamAnswers ? new Map(upstreamAnswers.map(a => [a?.id, a])) : null;
          restIndexes.forEach((i, k) => {
            const item = items[i];
            let answer;
            if (byPosition) answer = upstreamAnswers[k];
            else if (byId && item?.id !== undefined && byId.has(item.id)) answer = byId.get(item.id);
            if (answer === undefined) {
              answer = jsonRpcError(item?.id ?? null, -32603, 'Internal error: upstream request failed');
            } else if (!answer?.error) {
              servedUnits += requestUnits(item);
            }
            answers[i] = answer;
          });
        }));
      }
      await Promise.all(jobs);
      res.status(200).json(answers);
      const failed = answers.filter(a => a?.error?.code === -32603).length;
      console.log(`🪵 getLogs batch from ${clientIP}: ${slots} getLogs + ${restIndexes.length} other item(s), ${failed} failed, ${Date.now() - startedAt} ms`);

      // Count only what was served toward the IP/origin limiter (shared cost table;
      // getLogs items by their block count).
      if (servedUnits > 0) {
        updateIpCountMap(clientIP, req.headers.origin, servedUnits);
        if (req.headers.origin) updateUrlCountMap(req.headers.origin, servedUnits);
      }
      return;
    }
  }
  // ---- end getLogs policy path ---------------------------------------------------

  const isUsingFallback = circuitBreaker.isCurrentlyUsingFallback();
  const currentUrl = circuitBreaker.getCurrentUrl();
  
  console.log(`📡 POST Request - Using ${isUsingFallback ? 'FALLBACK' : 'PRIMARY'}: ${redactUrl(currentUrl)}`);
  
  // Track if we actually used fallback for this request (either from circuit breaker or immediate retry)
  let actuallyUsedFallback = isUsingFallback;
  let responseData = null;
  
  if (isUsingFallback) {
    console.log(`🚨 Using fallback URL for request from ${req.headers.origin || 'unknown'} - NOT counting in Firebase`);
  }

  // Handle method counting for both single requests and batch requests
  if (req.body) {
    const requests = Array.isArray(req.body) ? req.body : [req.body];
    
    requests.forEach(request => {
      if (request && request.method) {
        methods[request.method] = methods[request.method]
          ? methods[request.method] + 1
          : 1;
        console.log("--> METHOD", request.method, "REFERER", req.headers.referer, "URL", isUsingFallback ? "FALLBACK" : "PRIMARY", "IP", getClientIP(req), "ORIGIN", getOrigin(req));

        if (!methodsByReferer[req.headers.referer]) {
          methodsByReferer[req.headers.referer] = {};
        }

        methodsByReferer[req.headers.referer] &&
        methodsByReferer[req.headers.referer][request.method]
          ? methodsByReferer[req.headers.referer][request.method]++
          : (methodsByReferer[req.headers.referer][request.method] = 1);
      }
    });
  }

  let primaryFailure = null; // the primary's error when the fallback retry also fails
  try {
    let response;
    
    if (isUsingFallback) {
      // Circuit breaker says use fallback - use consistent fallback function
      response = await makeFallbackRequest(req.body, req.headers);
      // Don't delete this
      // console.log("POST RESPONSE", response.data, "(FALLBACK)");
    } else {
      // Try primary first
      try {
        response = await makePrimaryRequest('post', currentUrl, req.body, req.headers, getClientIP(req));
        // Don't delete this
        // console.log("POST RESPONSE", response.data, "(PRIMARY)");
      } catch (primaryError) {
        primaryFailure = primaryError;
        console.log("POST ERROR", primaryError.message, "(PRIMARY)");
        
        // Primary failed, try fallback immediately
        console.log(`🔄 Retrying with fallback URL: ${redactUrl(fallbackUrl)}`);
        actuallyUsedFallback = true;
        
        response = await makeFallbackRequest(req.body, req.headers);
        console.log("POST FALLBACK SUCCESS", response.status, `${response.headers?.['content-length'] ?? '?'} bytes`);
        
        // Early return - don't count in Firebase since we used fallback
        responseData = response.data;
        res.status(response.status).send(perItem(req.body, response.data));
        console.log("🚨 Used immediate fallback - NOT counting in Firebase");
        return;
      }
    }
    
    responseData = response.data;
    // A provider that answers a whole batch with one error object still gives the
    // caller an array (batch semantics).
    res.status(response.status).send(perItem(req.body, response.data));
    
  } catch (error) {
    console.log("POST ERROR", error.message, isUsingFallback ? "(FALLBACK)" : "(PRIMARY)");
    console.log(`   Error details: ${error.code || 'No code'} - ${error.response?.status || 'No status'}`);
    
    // Always JSON-RPC, always HTTP 200. A JSON-RPC body from the failing upstream is
    // passed through; otherwise the failure is classified (timeout / unavailable /
    // other). If the fallback failed without a body but the primary had answered one,
    // the primary's body is the more useful answer. error.message can name internal
    // hosts and ports, so it stays in the log.
    const answer = upstreamFailureAnswer(requestIdOf(req.body), error, { timeoutMs: 15000, what: 'upstream' });
    const primaryBody = answer.kind !== 'passthrough' && primaryFailure ? upstreamJsonRpcBody(primaryFailure) : null;
    console.log(`   Answering: ${primaryBody ? 'primary JSON-RPC body' : answer.kind}`);
    res.status(200).json(perItem(req.body, primaryBody || answer.body));
    return; // Don't count failed requests in Firebase
  }

  // Only count requests in Firebase if we successfully used primary URL (not fallback)
  if (!actuallyUsedFallback && responseData && req.headers) {
    // Weighted request count for rate limiting (shared cost table; heavy methods
    // count for more). getLogs never reaches this path, so no block count is needed.
    const requests = Array.isArray(req.body) ? req.body : [req.body];
    const requestCount = requests.reduce((sum, r) => sum + requestUnits(r), 0);
    if (requests.length > 1 || requestCount !== requests.length) {
      console.log(`Request count: ${requests.length} call(s) → ${requestCount} weighted unit(s)`);
    }

    // Always track IP counts (even without origin)
    updateIpCountMap(getClientIP(req), req.headers.origin, requestCount);
    
    // Only track URL counts if origin is present
    if (req.headers.origin) {
      updateUrlCountMap(req.headers.origin, requestCount);
      
      if (last === req.connection.remoteAddress) {
        //process.stdout.write(".");
        //process.stdout.write("-")
      } else {
        last = req.connection.remoteAddress;
        if (!memcache[req.headers.origin]) {
          memcache[req.headers.origin] = 1;
          process.stdout.write(
            "NEW SITE " +
              req.headers.origin +
              " --> " +
              req.connection.remoteAddress
          );
          process.stdout.write("🪐 " + req.connection.remoteAddress);
        } else {
          memcache[req.headers.origin]++;
        }
      }
    }
  } else if (actuallyUsedFallback) {
    console.log(`🚨 Used fallback for final response - NOT counting in Firebase`);
  }

  // Handle method counting for both single requests and batch requests
  if (req.body) {
    const requests = Array.isArray(req.body) ? req.body : [req.body];
    
    requests.forEach(request => {
      if (request && request.method) {
        methods[request.method] = methods[request.method]
          ? methods[request.method] + 1
          : 1;
        console.log("--> METHOD", request.method, "REFERER", req.headers.referer, "URL", actuallyUsedFallback ? "FALLBACK" : "PRIMARY", "IP", getClientIP(req), "ORIGIN", getOrigin(req));

        if (!methodsByReferer[req.headers.referer]) {
          methodsByReferer[req.headers.referer] = {};
        }

        methodsByReferer[req.headers.referer] &&
        methodsByReferer[req.headers.referer][request.method]
          ? methodsByReferer[req.headers.referer][request.method]++
          : (methodsByReferer[req.headers.referer][request.method] = 1);
      }
    });
  }

  const bodyForLog = Array.isArray(req.body)
    ? req.body.map(({ params: _, ...rest }) => rest)
    : (req.body ? (({ params: _, ...rest }) => rest)(req.body) : req.body);
  console.log("POST SERVED", bodyForLog);
});

app.get("/", async (req, res) => {
  try {
    // For GET requests, always try primary first (don't use circuit breaker logic)
    // GET requests to RPC endpoints often return 404 even when server is healthy
    console.log("GET", req.headers.referer || "no referer");
    
    try {
      // Use a simple axios call for GET requests (no circuit breaker)
      const response = await axios.get(targetUrl, {
        headers: upstreamHeaders(req.headers, getClientIP(req)),
        httpsAgent: internalAgent,
        timeout: 10000
      });
      console.log("GET RESPONSE", response.data);
      res.status(response.status).send(response.data);
    } catch (error) {
      console.log("GET ERROR", error.message, "- This is normal for RPC endpoints");
      
      // For GET requests, if primary fails and fallback is configured, try fallback
      if (fallbackUrl && fallbackUrl.trim() !== '') {
        try {
          console.log("🔄 Trying GET with fallback URL...");
          const fallbackResponse = await axios.get(fallbackUrl, {
            headers: upstreamHeaders(req.headers), // no client IP to the fallback provider
            timeout: 10000,
            httpsAgent: fallbackAgent
          });
          console.log("GET FALLBACK SUCCESS", fallbackResponse.data);
          res.status(fallbackResponse.status).send(fallbackResponse.data);
          return;
        } catch (fallbackError) {
          console.log("GET FALLBACK ALSO FAILED", fallbackError.message, "- This is also normal for RPC endpoints");
        }
      }
      
      res
        .status(error.response ? error.response.status : 500)
        .send(error.message);
    }

    console.log("GET REQUEST SERVED");
  } catch (err) {
    console.error("GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/proxy", (req, res) => {
  try {
    const status = circuitBreaker.getStatus();
    console.log("/PROXY", req.headers.referer);
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'>" +
      "<H1>PROXY TO:</H1>" +
      "<div><strong>Primary:</strong> " + targetUrl + "</div>" +
      "<div><strong>Fallback:</strong> " + redactUrl(fallbackUrl) + "</div>" +
      "<div><strong>Current:</strong> " + status.currentTarget + "</div>" +
      "<div><strong>Status:</strong> " + status.state + "</div>" +
      "<div><strong>Using Fallback:</strong> " + status.isUsingFallback + "</div>" +
      "<div><strong>Consecutive Failures:</strong> " + status.consecutiveFailures + "</div>" +
      "</div></body></html>"
    );
  } catch (err) {
    console.error("/proxy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/methods", (req, res) => {
  try {
    console.log("/methods", req.headers.referer);
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>methods:</H1></div><pre>" +
        JSON.stringify(methods) +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/methods error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/methodsByReferer", (req, res) => {
  try {
    console.log("/methods", req.headers.referer);
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>methods by referer:</H1></div><pre>" +
        JSON.stringify(methodsByReferer) +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/methodsByReferer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/letathousandscaffoldethsbloom", (req, res) => {
  try {
    //if(req.headers&&req.headers.referer&&req.headers.referer.indexOf("sandbox.eth.build")>=0){
    var sortable = [];
    for (var item in memcache) {
      sortable.push([item, memcache[item]]);
    }
    sortable.sort(function (a, b) {
      return b[1] - a[1];
    });
    let finalBody = "";
    for (let s in sortable) {
      console.log(sortable[s]);
      finalBody +=
        "<div style='padding:10px;font-size:18px'> <a href='" +
        sortable[s][0] +
        "'>" +
        sortable[s][0] +
        "</a>(" +
        sortable[s][1] +
        ")</div>";
    }
    //JSON.stringify(sortable)
    res.send(
      "<html><body><div style='padding:20px;font-size:18px'><H1>RPC TRAFFIC</H1></div><pre>" +
        finalBody +
        "</pre></body></html>"
    );
  } catch (err) {
    console.error("/letathousandscaffoldethsbloom error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/watchdog", (req, res) => {
  try {
    res.json({ ok: true });
  } catch (err) {
    console.error("/watchdog error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Circuit breaker status. Unauthenticated, so it carries state only: no URLs (the
// fallback URL holds the provider key). Anything sensitive added later (key usage in
// Phase 4) goes behind requireAdminKey, not here.
app.get("/status", (req, res) => {
  try {
    const status = circuitBreaker.getStatus();
    res.json({
      circuitBreaker: status,
      getLogs: {
        keyless: getLogsKeyless,
        edgeInFlight: getLogsInFlight,
        edgeConcurrencyCap: getLogsGlobalConcurrency,
        ...getGetLogsState()
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("/status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Rate limit status endpoint (for monitoring) - protected by API key
app.get("/ratelimitstatus", requireAdminKey, (req, res) => {
  try {
    const status = getRateLimitStatus();
    res.json({
      ...status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("/ratelimitstatus error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// IP blacklist status endpoint (for monitoring) - protected by API key
app.get("/blackliststatus", requireAdminKey, (req, res) => {
  try {
    const status = getBlacklistStatus();
    res.json({
      ...status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("/blackliststatus error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start background tasks
startBackgroundTasks();

// Start rate limit polling
startRateLimitPolling();

// Start IP blacklist watcher
startWatchingBlacklist();

// Head + receipt-floor pollers for the getLogs policy (only needed while the path is open)
if (getLogsKeyless) {
  startGetLogsPollers(targetUrl);
}

// PORT is only for running a second instance next to the live one (tests); the
// service itself listens on 443.
const listenPort = Number(process.env.PORT) || 443;

let key, cert;
try {
  key = fs.readFileSync("server.key");
  cert = fs.readFileSync("server.cert");
} catch (err) {
  console.error("Failed to read SSL certificate files:", err);
  process.exit(1);
}

https
  .createServer(
    {
      key,
      cert,
    },
    app
  )
  .listen(listenPort, () => {
    console.log(`Listening ${listenPort}...`);
  });
