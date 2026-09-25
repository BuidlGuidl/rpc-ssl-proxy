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
import { checkRateLimit, buildRateLimitResponse, getRateLimitStatus, startRateLimitPolling, getSecondsUntilNextHour } from './utils/rateLimiter.js';
import { validateRpcRequest } from './utils/requestValidator.js';
import { rejectDisabledMethods } from './utils/disabledMethods.js';
import { isIPBlacklisted, startWatchingBlacklist, getBlacklistStatus } from './utils/ipBlacklist.js';
import { requireAdminKey } from './utils/adminAuth.js';
import {
  defaultRequestCount, methodRequestCounts, forwardedHeaders,
  getLogsMethods, getLogsGlobalConcurrency, getLogsUpstreamTimeoutMs, getLogsMaxResponseBytes
} from './config.js';
import { redactUrl } from './utils/redactUrl.js';
import { validateGetLogs, startGetLogsPollers, getGetLogsState } from './utils/getLogsPolicy.js';

var app = express();
https.globalAgent.options.ca = sslRootCas.create();
dotenv.config();
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

// Nothing sits in front of this service, so forwarding headers are caller-supplied
// and unverifiable. Keeping this false makes req.ip the address observed on the socket.
// If a CDN or load balancer is added later, set this to that proxy's CIDR ranges.
app.set('trust proxy', false);

const targetUrl = process.env.TARGET_URL;
const fallbackUrl = process.env.FALLBACK_URL;

console.log(`🔧 RPC Proxy Configuration:`);
console.log(`   Primary URL: ${targetUrl || 'NOT SET'}`);
console.log(`   Fallback URL: ${redactUrl(fallbackUrl)}`);

// Stage-only switch (plan D10, Phase 4 policy pass): let getLogs through the policy
// path WITHOUT an API key so the whole chain can be proven before keys exist. It
// refuses to start unless TARGET_URL is a stage host or localhost, so it can't be
// left on in production by accident. Removed when the keys pass lands.
const getLogsKeylessStage = ['1', 'true', 'yes'].includes(String(process.env.GETLOGS_KEYLESS_STAGE || '').toLowerCase());
if (getLogsKeylessStage) {
  let host = '';
  try { host = new URL(targetUrl).hostname; } catch { /* handled below */ }
  const isStageHost = /^stage\./i.test(host) || host === 'localhost' || host === '127.0.0.1';
  if (!isStageHost) {
    console.error(`GETLOGS_KEYLESS_STAGE is set but TARGET_URL host "${host || targetUrl}" is not a stage host (stage.*) or localhost. Refusing to start.`);
    process.exit(1);
  }
  console.log(`⚠️  GETLOGS_KEYLESS_STAGE is ON: getLogs is served without an API key (stage only, target ${host})`);
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
app.use(bodyParser.json());
app.use(cors());

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
// is re-serialized from req.body.
function upstreamHeaders(clientHeaders) {
  const headers = { "Content-Type": "application/json" };
  for (const name of forwardedHeaders) {
    const value = clientHeaders?.[name];
    if (typeof value === 'string' && value !== '') {
      headers[name] = value;
    }
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
    httpsAgent: new https.Agent({
      rejectUnauthorized: false
    })
  });
}

// getLogs-path in-flight counter (edge-wide cap, D8).
let getLogsInFlight = 0;

// Forward a getLogs-path request to bg-rpc-proxy. Differences from
// makePrimaryRequest: its own (longer) timeout, a response size cap, and it never
// touches the circuit breaker or the fallback: a getLogs failure is returned to the
// caller as JSON-RPC, never retried on a paid provider (plan 4c step 5).
async function makeGetLogsRequest(data, headers) {
  return axios.post(targetUrl, data, {
    headers: upstreamHeaders(headers),
    timeout: getLogsUpstreamTimeoutMs,
    maxContentLength: getLogsMaxResponseBytes,
    maxBodyLength: getLogsMaxResponseBytes
  });
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Helper function to make primary requests with circuit breaker
async function makePrimaryRequest(method, url, data, headers, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const config = {
      method,
      url,
      headers: upstreamHeaders(headers),
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
    
    // Return the same rate limit error for blacklisted IPs
    res.status(429)
      .set('Retry-After', '3600') // 1 hour
      .json(buildRateLimitResponse(requestId));
    return;
  }
  
  // getLogs and the filter methods (D9). Without the stage switch they are blocked
  // for everyone (today's behavior; the keys pass replaces this with -32601). With it,
  // they take the policy path below, after the rate limiter.
  const heavyItems = (Array.isArray(req.body) ? req.body : [req.body]).filter(r => getLogsMethods.includes(r?.method));
  if (heavyItems.length > 0 && !getLogsKeylessStage) {
    console.log(`🚫 Blocked ${heavyItems.map(r => r.method).join(',')} from ${clientIP}`);
    res.status(429)
      .set('Retry-After', String(getSecondsUntilNextHour()))
      .json(buildRateLimitResponse(requestIdOf(req.body)));
    return;
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
      .json(buildRateLimitResponse(requestId));
    return;
  }
  
  // ---- getLogs policy path (plan 4c/4d, policy pass) ----------------------------
  if (heavyItems.length > 0) {
    // 1. validate every heavy item; the first failure answers the whole request
    for (const item of heavyItems) {
      const verdict = validateGetLogs(item);
      if (!verdict.ok) {
        console.log(`🪵 getLogs rejected (${item.method}) from ${clientIP}: ${verdict.error.code} ${verdict.error.message}`);
        res.status(200).json(jsonRpcError(item.id, verdict.error.code, verdict.error.message));
        return;
      }
    }

    // 2. edge-wide capacity
    if (getLogsInFlight >= getLogsGlobalConcurrency) {
      console.log(`🪵 getLogs capacity: ${getLogsInFlight} in flight, rejecting request from ${clientIP}`);
      res.status(429)
        .set('Retry-After', '2')
        .json(jsonRpcError(requestIdOf(req.body), -32005, 'getLogs capacity exhausted at the edge, retry shortly'));
      return;
    }

    // 3. forward: own timeout, size cap, no breaker, no fallback
    getLogsInFlight++;
    const startedAt = Date.now();
    try {
      const response = await makeGetLogsRequest(req.body, req.headers);
      res.status(200).send(response.data);
      console.log(`🪵 getLogs served (${heavyItems.map(r => r.method).join(',')}) from ${clientIP} in ${Date.now() - startedAt} ms, upstream ${response.headers?.['content-length'] ?? '?'} bytes`);
    } catch (error) {
      const tooLarge = /maxContentLength|maxBodyLength/i.test(error.message || '');
      console.log(`🪵 getLogs upstream error after ${Date.now() - startedAt} ms: ${error.code || 'no code'} ${error.message}`);
      res.status(200).json(jsonRpcError(
        requestIdOf(req.body),
        -32603,
        tooLarge ? 'Internal error: response too large' : 'Internal error: upstream request failed'
      ));
    } finally {
      getLogsInFlight--;
    }

    // Count toward the IP/origin limiter like any other served request (weighted).
    const requests = Array.isArray(req.body) ? req.body : [req.body];
    const requestCount = requests.reduce((sum, r) => sum + (methodRequestCounts[r?.method] ?? defaultRequestCount), 0);
    updateIpCountMap(clientIP, req.headers.origin, requestCount);
    if (req.headers.origin) updateUrlCountMap(req.headers.origin, requestCount);
    return;
  }
  // ---- end getLogs policy path ---------------------------------------------------

  const isUsingFallback = circuitBreaker.isCurrentlyUsingFallback();
  const currentUrl = circuitBreaker.getCurrentUrl();
  
  console.log(`📡 POST Request - Using ${isUsingFallback ? 'FALLBACK' : 'PRIMARY'}: ${currentUrl}`);
  
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
        response = await makePrimaryRequest('post', currentUrl, req.body, req.headers);
        // Don't delete this
        // console.log("POST RESPONSE", response.data, "(PRIMARY)");
      } catch (primaryError) {
        console.log("POST ERROR", primaryError.message, "(PRIMARY)");
        
        // Primary failed, try fallback immediately
        console.log(`🔄 Retrying with fallback URL: ${fallbackUrl}`);
        actuallyUsedFallback = true;
        
        response = await makeFallbackRequest(req.body, req.headers);
        console.log("POST FALLBACK SUCCESS", response.status, `${response.headers?.['content-length'] ?? '?'} bytes`);
        
        // Early return - don't count in Firebase since we used fallback
        responseData = response.data;
        res.status(response.status).send(response.data);
        console.log("🚨 Used immediate fallback - NOT counting in Firebase");
        return;
      }
    }
    
    responseData = response.data;
    res.status(response.status).send(response.data);
    
  } catch (error) {
    console.log("POST ERROR", error.message, isUsingFallback ? "(FALLBACK)" : "(PRIMARY)");
    console.log(`   Error details: ${error.code || 'No code'} - ${error.response?.status || 'No status'}`);
    
    // Always JSON-RPC, always HTTP 200, like every other error path. The detail stays
    // in the log: error.message can name internal hosts and ports.
    res.status(200).json({
      jsonrpc: "2.0",
      id: requestIdOf(req.body),
      error: {
        code: -32603,
        message: "Internal error: upstream request failed"
      }
    });
    return; // Don't count failed requests in Firebase
  }

  // Only count requests in Firebase if we successfully used primary URL (not fallback)
  if (!actuallyUsedFallback && responseData && req.headers) {
    // Weighted request count for rate limiting (heavy methods count for more)
    const requests = Array.isArray(req.body) ? req.body : [req.body];
    const requestCount = requests.reduce((sum, r) => {
      if (!r || typeof r.method !== 'string') return sum + defaultRequestCount;
      const weight = methodRequestCounts[r.method] ?? defaultRequestCount;
      return sum + weight;
    }, 0);
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
        headers: upstreamHeaders(req.headers),
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
            headers: upstreamHeaders(req.headers),
            timeout: 10000,
            httpsAgent: new https.Agent({
              rejectUnauthorized: false
            })
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
        keylessStage: getLogsKeylessStage,
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
if (getLogsKeylessStage) {
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
