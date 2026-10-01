import { forwardedHeaders } from '../config.js';
import { classifyOrigin } from './rateLimiter.js';

// Build the header set for the next hop. Only the allowlisted caller headers cross
// (see forwardedHeaders in config.js); Content-Type is always ours because the body
// is re-serialized from req.body. When clientIP is given (requests to TARGET_URL,
// bg-rpc-proxy, which logs it), X-Client-IP carries the caller's socket address as
// seen by this edge: the same value the rate limiter uses (getClientIP). A caller's
// own X-Client-IP is never forwarded (it isn't in the allowlist). Calls without
// clientIP (the fallback provider) never get the header.
//
// An Origin the rate limiter doesn't track (classifyOrigin 'untracked': localhost,
// ports, IPs, '*', ...) is left out of the copy sent on (bg-rpc-docs
// ORIGIN_CLASS_PLAN.md, D7), so downstream logs it like a request without one.
// Only this copy changes: req.headers keeps the caller's header for the rate limiter,
// the database counters and CORS.
function upstreamHeaders(clientHeaders, clientIP) {
  const headers = { "Content-Type": "application/json" };
  for (const name of forwardedHeaders) {
    const value = clientHeaders?.[name];
    if (typeof value === 'string' && value !== '') {
      if (name === 'origin' && classifyOrigin(value) === 'untracked') continue;
      headers[name] = value;
    }
  }
  if (typeof clientIP === 'string' && clientIP !== '') {
    headers["X-Client-IP"] = clientIP;
  }
  return headers;
}

export { upstreamHeaders };
