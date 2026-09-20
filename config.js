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
// API KEYS
// =============================================================================
// Keys are minted by rpc-token-manager into Firestore (`rpcKeys<FIREBASE_COLLECTION>`).
// A request carrying a valid key (`POST /v1/<key>` or `X-Api-Key` header) skips the
// IP/origin limiter and is charged against a per-key budget instead, and may call
// eth_getLogs within the bounds below. Requests without a key behave as before:
// eth_getLogs stays blocked.
// =============================================================================

const apiKeyRefreshInterval = 60;        // Seconds between Firestore mirror refreshes
const apiKeyRateLimitPerHour = 50000;    // Weighted units per key per rolling hour (charged up front)
const getLogsMaxBlockRange = 2000;       // Max blocks a single keyed eth_getLogs may span
const getLogsMaxInFlightPerKey = 2;      // Max concurrent eth_getLogs per key
const apiKeySignupUrl = "https://rpc.buidlguidl.com"; // Shown in the no-key eth_getLogs error

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
  apiKeyRefreshInterval,
  apiKeyRateLimitPerHour,
  getLogsMaxBlockRange,
  getLogsMaxInFlightPerKey,
  apiKeySignupUrl
};