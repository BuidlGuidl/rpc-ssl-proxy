const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// const rpcFunderContractAddress = "0x291469065a4DDdE2CA9f6A53ab4Aa148B8e42f48";
const backgroundTasksInterval = 10; //seconds

// Firebase holds the donation ledger behind rpc.buidlguidl.com (funded balances and
// the displayed request totals). Nothing in the request path reads it, so writes can
// be off without affecting RPC serving or rate limiting.
//
// Disabled: urlList is a single document with one field per origin, and the flood of
// junk origins pushed it past Firestore's per-document index entry cap, so every write
// fails. Re-enabling requires re-modelling urlList as a subcollection and filtering
// origins before writing, or the same limit will be hit again.
const firebaseUpdatesEnabled = false;

// =============================================================================
// RATE LIMITING CONFIGURATION
// =============================================================================
// 
// We use a two-tier rate limiting system:
//   1. Sliding window hourly limit (smooths out hour-boundary gaming)
//   2. Daily limit (prevents sustained abuse across hours)
//
// Origins (deployed apps) get higher limits since they represent apps with many users.
// IPs with no origin (local testing) get lower limits since they represent individual developers.
//
// The sliding window uses an approximation: at any point in time, the effective
// request count = (current_hour_count) + (previous_hour_count × time_remaining_weight)
// This prevents users from "bursting" at hour boundaries.
// =============================================================================

// Hourly limits (used with sliding window approximation)
const originRateLimitPerHour = 4000;  // Max requests per rolling hour for a single origin (deployed app)
const ipRateLimitPerHour = 1000;      // Max requests per rolling hour for an IP with no origin (local testing)

// Daily limits (hard cap, resets at midnight UTC)
// Set these lower than 24× hourly to provide meaningful secondary protection
const originRateLimitPerDay = 40000;  // Max requests per day for a single origin
const ipRateLimitPerDay = 5000;      // Max requests per day for an IP with no origin

// Polling interval
const rateLimitPollInterval = 10;   // How often to poll DB for rate limit data (seconds)

// =============================================================================
// REQUEST COUNT WEIGHTS (for rate limiting)
// =============================================================================
// Each request can count as more than 1 toward rate limits. Heavier methods
// use more provider resources and count for more. Limits in config above are
// in "weighted request units" (e.g. 4000/hour = 4000 units, not 4000 calls).
// =============================================================================

/** Default count per request when method is not listed in methodRequestCounts */
const defaultRequestCount = 1;

/**
 * Map of JSON-RPC method name -> request count (weight) for rate limiting.
 * Only list methods that should count for more than defaultRequestCount.
 */
const methodRequestCounts = {
  // Heavy log/block range queries
  eth_getLogs: 100,
  // Full block with transactions
  eth_getBlockByNumber: 2,
  eth_getBlockByHash: 2,
};

// =============================================================================
// EDGE HYGIENE (bg-rpc-docs plan, Phase 1d)
// =============================================================================

/** Max items in a JSON-RPC batch. Larger batches get -32600 before anything is forwarded. */
const maxBatchLength = 50;

/**
 * Caller headers (lowercase) that are forwarded upstream. Everything else is dropped:
 * bg-rpc-proxy forwards headers to its fallback provider, so an X-Api-Key would leak;
 * a forwarded Content-Length/Transfer-Encoding no longer matches the re-serialized
 * body; and a forwarded Accept-Encoding overrides axios's own compression negotiation.
 */
const forwardedHeaders = ['user-agent', 'origin'];

// =============================================================================
// GETLOGS POLICY (bg-rpc-docs plan, Phase 4 policy pass; D1, D8, D9)
// =============================================================================

/**
 * Methods rejected at the edge with -32601 "<method> is not supported on this
 * endpoint; use eth_getLogs" (bg-rpc-docs plan, D15). Mirrors `disabledMethods` in
 * bg-rpc-pool/config.js: a filter id exists only on the node that created it, so
 * follow-up calls fail once there is more than one node. Rejected right after
 * validation, before key checks, the rate limiter and metering; re-enable here and
 * in the pool together once filter-id → node routing exists (after Phase 3b).
 */
const disabledMethods = [
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_uninstallFilter'
];

/** Methods that get the getLogs policy and forwarding path (D9). While D15 is in force the filter methods never reach this path. */
const getLogsMethods = ['eth_getLogs', 'eth_newFilter', 'eth_getFilterLogs', 'eth_getFilterChanges'];

/** Max blocks per getLogs call (D1). Over this → -32602 with a suggested range. */
const getLogsMaxBlockRange = 10000;

/** Sanity caps on the filter object; reth handles anything finer. */
const getLogsMaxAddresses = 10;
const getLogsMaxTopics = 4;

/** Edge-wide in-flight cap for getLogs-path requests (D8). Over this → -32005, HTTP 429. */
const getLogsGlobalConcurrency = 16;

/** Edge → bg-rpc-proxy timeout for the getLogs path (ms). Must exceed bg-rpc-proxy's 8 s. */
const getLogsUpstreamTimeoutMs = 12000;

/** Largest getLogs-path response the edge will accept from upstream (bytes). */
const getLogsMaxResponseBytes = 20e6;

/** How often the edge refreshes the chain head (eth_blockNumber to TARGET_URL) and the pool's receipt floor (/getlogsStatus). Seconds. */
const getLogsHeadPollInterval = 12;
const getLogsFloorPollInterval = 60;

/** A head or floor older than this is treated as unknown (getLogs fails closed). Seconds. */
const getLogsHeadMaxAge = 120;
const getLogsFloorMaxAge = 600;

export {
  usdcAddress,
  // rpcFunderContractAddress,
  backgroundTasksInterval,
  firebaseUpdatesEnabled,
  originRateLimitPerHour,
  ipRateLimitPerHour,
  originRateLimitPerDay,
  ipRateLimitPerDay,
  rateLimitPollInterval,
  defaultRequestCount,
  methodRequestCounts,
  maxBatchLength,
  forwardedHeaders,
  disabledMethods,
  getLogsMethods,
  getLogsMaxBlockRange,
  getLogsMaxAddresses,
  getLogsMaxTopics,
  getLogsGlobalConcurrency,
  getLogsUpstreamTimeoutMs,
  getLogsMaxResponseBytes,
  getLogsHeadPollInterval,
  getLogsFloorPollInterval,
  getLogsHeadMaxAge,
  getLogsFloorMaxAge
};