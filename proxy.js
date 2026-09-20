import https from "https";
import express from "express";
import axios from "axios";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from 'url';
import ethers from "ethers";
import sslRootCas from "ssl-root-cas";
import dotenv from "dotenv";
import { updateUrlCountMap, updateIpCountMap, startBackgroundTasks } from './utils/backgroundTasks.js';
import { CircuitBreaker } from './utils/circuitBreaker.js';
import { checkRateLimit, buildRateLimitResponse, getRateLimitStatus, startRateLimitPolling, getSecondsUntilNextHour } from './utils/rateLimiter.js';
import { validateRpcRequest } from './utils/requestValidator.js';
import { isIPBlacklisted, startWatchingBlacklist, getBlacklistStatus } from './utils/ipBlacklist.js';
import { requireAdminKey } from './utils/adminAuth.js';
import { defaultRequestCount, methodRequestCounts, apiKeySignupUrl, getLogsMaxInFlightPerKey } from './config.js';
import { resolveApiKey, startApiKeyPolling, getApiKeyStoreStatus } from './utils/apiKeys.js';
import { consumeKeyUnits, acquireGetLogsSlots, releaseGetLogsSlots, getKeyRateLimitStatus } from './utils/keyRateLimiter.js';
import { checkGetLogsParams } from './utils/getLogsGuard.js';
import { getLatestBlock, startLatestBlockPolling, getLatestBlockStatus } from './utils/latestBlock.js';
import { logRejectedRequest } from './utils/rejectLogger.js';

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
console.log(`   Fallback URL: ${fallbackUrl || 'NOT SET'}`);

// Initialize circuit breaker
const circuitBreaker = new CircuitBreaker({
  primaryUrl: targetUrl,
  fallbackUrl: fallbackUrl,
  failureThreshold: 2, // Switch to fallback after 2 consecutive failures
  resetTimeout: 60000, // Try primary again after 60 seconds
  requestTimeout: 15000 // 15 second timeout
});

app.use(bodyParser.json());
app.use(cors());

// Validate RPC requests early to avoid forwarding invalid requests to downstream service
app.use(validateRpcRequest);

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

// Weighted request units (heavy methods count for more; see config.methodRequestCounts)
function weighRequests(requests) {
  return requests.reduce((sum, r) => {
    if (!r || typeof r.method !== 'string') return sum + defaultRequestCount;
    return sum + (methodRequestCounts[r.method] ?? defaultRequestCount);
  }, 0);
}

function maskKey(key) {
  return typeof key === 'string' && key.length > 6 ? `${key.slice(0, 4)}…${key.slice(-2)}` : '******';
}

function buildRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
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

// Helper function to make primary requests with circuit breaker
async function makePrimaryRequest(method, url, data, headers, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const config = {
      method,
      url,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
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

app.post(["/", "/v1/:key"], async (req, res) => {
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
  
  // API key: `POST /v1/<key>` or an X-Api-Key header. A presented-but-bad key is
  // refused outright. No key at all is the anonymous path, unchanged from before.
  const apiKeyResult = resolveApiKey(req);
  const apiKey = apiKeyResult.status === 'valid' ? apiKeyResult : null;
  const requests = Array.isArray(req.body) ? req.body : [req.body];
  const firstRequestId = requests[0]?.id ?? null;
  if (apiKeyResult.status === 'invalid') {
    console.log(`🔒 Rejected API key from ${clientIP}: ${apiKeyResult.reason}`);
    logRejectedRequest(req, `invalid API key: ${apiKeyResult.reason}`);
    res.status(401).json(buildRpcError(firstRequestId, -32001, 'Invalid API key'));
    return;
  }
  const weightedUnits = weighRequests(requests);

  // eth_getLogs: blocked without a key, bounded with one (range cap + concurrency cap).
  const getLogsCalls = requests.filter(r => r?.method === 'eth_getLogs');
  if (getLogsCalls.length > 0) {
    if (!apiKey) {
      console.log(`🚫 Blocked eth_getLogs from ${clientIP} (no API key)`);
      logRejectedRequest(req, 'eth_getLogs without API key');
      res.status(429)
        .set('Retry-After', String(getSecondsUntilNextHour()))
        .json(buildRpcError(firstRequestId, -32005, `eth_getLogs requires an API key. Get one at ${apiKeySignupUrl}`));
      return;
    }
    const latest = getLatestBlock();
    for (const call of getLogsCalls) {
      const verdict = checkGetLogsParams(call.params, latest);
      if (!verdict.ok) {
        console.log(`🚫 Refused eth_getLogs for key ${maskKey(apiKey.key)}: ${verdict.message}`);
        logRejectedRequest(req, `eth_getLogs refused: ${verdict.message}`);
        res.status(200).json(buildRpcError(call.id ?? firstRequestId, -32602, verdict.message));
        return;
      }
    }
    if (!acquireGetLogsSlots(apiKey.key, getLogsCalls.length)) {
      console.log(`🚫 Too many concurrent eth_getLogs for key ${maskKey(apiKey.key)}`);
      res.status(429)
        .set('Retry-After', '1')
        .json(buildRpcError(firstRequestId, -32005, `Too many concurrent eth_getLogs for this API key (max ${getLogsMaxInFlightPerKey})`));
      return;
    }
    let released = false;
    const release = () => { if (!released) { released = true; releaseGetLogsSlots(apiKey.key, getLogsCalls.length); } };
    res.once('finish', release);
    res.once('close', release);
  }

  if (apiKey) {
    // Keyed: charged up front against the per-key budget. IP/origin limits do not apply.
    const budget = consumeKeyUnits(apiKey.key, weightedUnits);
    if (budget.limited) {
      console.log(`🚫 API key ${maskKey(apiKey.key)} over hourly budget (~${budget.effective}/${budget.limit} units)`);
      res.status(429)
        .set('Retry-After', String(budget.retryAfter))
        .json(buildRateLimitResponse(firstRequestId));
      return;
    }
  } else {
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
  }
  
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
        console.log("POST FALLBACK SUCCESS", response.data);
        
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
    
    res
      .status(error.response ? error.response.status : 500)
      .send(error.message);
    return; // Don't count failed requests in Firebase
  }

  // Only count requests in Firebase if we successfully used primary URL (not fallback)
  if (!actuallyUsedFallback && responseData && req.headers) {
    // Weighted request count for rate limiting (heavy methods count for more)
    const requestCount = weightedUnits;
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
        headers: { ...req.headers },
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
            headers: { ...req.headers },
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
      "<div><strong>Fallback:</strong> " + fallbackUrl + "</div>" +
      "<div><strong>Current:</strong> " + status.currentUrl + "</div>" +
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

// Add circuit breaker status endpoint
app.get("/status", (req, res) => {
  try {
    const status = circuitBreaker.getStatus();
    res.json({
      circuitBreaker: status,
      urls: {
        primary: targetUrl,
        fallback: fallbackUrl
      },
      apiKeys: getApiKeyStoreStatus(),
      keyLimits: getKeyRateLimitStatus(),
      latestBlock: getLatestBlockStatus(),
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

// API keys (Firestore mirror) and the cached chain head the getLogs guard resolves tags against
startApiKeyPolling();
startLatestBlockPolling(async () => {
  const r = await axios.post(targetUrl, { jsonrpc: "2.0", id: "proxy-head", method: "eth_blockNumber", params: [] }, { timeout: 5000, headers: { "content-type": "application/json" } });
  return r.data?.result;
});

// Start IP blacklist watcher
startWatchingBlacklist();

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
  .listen(443, () => {
    console.log("Listening 443...");
  });
