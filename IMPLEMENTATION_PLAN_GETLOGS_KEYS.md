# Implementation Plan: Keyed `eth_getLogs` Access

Status: **proposed, nothing implemented.** Written 2026-09-23.

Goal: re-enable `eth_getLogs` for callers holding an API key, with metering and hard
limits, without repeating the outage that led to the block. Anonymous callers stay
blocked. Design target is Alchemy's Pay As You Go behavior where the infrastructure
allows it (see `GETLOGS_RETH_TEST_RESULTS.md`, "Design target: Alchemy Pay As You Go").

Evidence for every limit and change below is in `GETLOGS_RETH_TEST_RESULTS.md`
(referred to as **the results file**). This document says *what to build, where, and
in what order*; it does not repeat the measurements.

## Systems involved

| Layer | Repo | Runs on | Role in this plan |
|---|---|---|---|
| Edge proxy | `rpc-ssl-proxy` (this repo) | this machine | keys, metering, getLogs policy, error format |
| Downstream proxy | `austintgriffith/geth-node-ssl-proxy` @ `bg-rpc-proxy` | downstream machine, port 48544 | batch cap, no fallback for getLogs |
| Pool | `BuidlGuidl/bg-rpc-pool` | downstream machine, port 3003 | Socket.IO transport fixes, getLogs routing |
| Log aggregator | `BuidlGuidl/bg-rpc-logs` | downstream machine, port 3001 | node timeout ratings (unchanged, but affected) |
| Dashboard | `BuidlGuidl/bg-rpc-web-server` | downstream machine, port 48547 | key usage page |
| Node client | `BuidlGuidl/buidlguidl-client` | volunteer machines | reth flags, check-in fields |

The request chain is edge → bg-rpc-proxy → pool → node (over Socket.IO) → reth.

## Decisions (defaults chosen so the plan is executable; confirm before Phase 3)

| # | Decision | Default in this plan | Why |
|---|---|---|---|
| D1 | Max block range per getLogs | **10,000** | worst case ~1.6 s; everything else in the plan assumes it. Revisit 100k later (Phase 7). |
| D2 | Log cap per response (node flag) | **10,000** | matches Alchemy's rule for ranges > 2k; halves the default 20k for the chain's sake. ~6.5 MB max. |
| D3 | History below L | **reject with a clear error** | simplest; forwarding old ranges to Alchemy is Phase 7 |
| D4 | Metering | **by range**: `5 + ceil(range/100)` units per call | cost follows range; 10k blocks = 105 units ≈ the current `eth_getLogs: 100` weight |
| D5 | Key store | **Postgres (RDS)**, same DB as `ip_table` | keys and usage together; no new dependency |
| D6 | Key issuance | **manual**, via admin endpoint / script | issuance is the security boundary; automate later if needed |
| D7 | Key transport | `X-Api-Key` header **and** `/v1/<key>` path | many tools only accept a URL (Alchemy-style); path must be redacted in logs |
| D8 | Concurrency | per key **2**, per reth node **4** (pool), global edge cap **16** | test 6 ceiling is 8/node; 4 leaves headroom for volunteer hardware |
| D9 | Filter methods | `eth_newFilter`, `eth_getFilterLogs`, `eth_getFilterChanges` **treated as getLogs** at the edge | confirmed bypass (results file, future-work finding 1) |

## Timeouts (must nest; today they don't)

For getLogs only. Other methods keep current values; aligning them is a separate task.

| Layer | Now | Target | Rule |
|---|---|---|---|
| reth (node) | none | none | node caps bound the work instead |
| buidlguidl-client → reth (axios) | none | **4 s**, `maxContentLength` 32 MB | returns an error instead of hanging or disconnecting; must be shorter than the pool's timeout so the pool sees an error, not a timeout |
| Pool per-node | 10 s + retry on 2nd node | **5 s, no retry** | slowest 10k query ~1.6 s |
| bg-rpc-proxy → pool | 15 s (+10 s fallback) | **8 s, no fallback** | > pool total |
| Edge → bg-rpc-proxy | 15 s (+ fallback, + breaker) | **12 s, no fallback, not counted by the breaker** | > bg-rpc-proxy total |

Each layer's timeout is longer than everything below it, including retries, so a
timeout can only originate at the bottom.

---

## Phase 0: Confirm and baseline (before any code)

Cheap checks that decide how urgent Phase 1 is and give before/after numbers.

1. **The 1 MB Socket.IO limit is established.** Production runs `main`, and the code
   chain is complete: the node returns the full RPC result as one Socket.IO ack
   (`buidlguidl-client/webSocketConnection.js` ~line 181) → the pool creates its
   server with no `maxHttpBufferSize` (`pool.js` ~line 170) → engine.io defaults it
   to `1e6` and passes it to `ws` as `maxPayload` (and enforces it on the polling
   transport too) → `ws` closes the connection with code 1009 when a message exceeds
   it, fragments included → the pool sees a timeout and a disconnect. Test 11
   showed ~25% of `eth_getBlockReceipts` responses exceed 1,000,000 bytes.
   One capture on the downstream machine, as the Phase 1a **before** number:
   - `awk -F'|' '{print $4}' /home/ubuntu/shared/fallbackRequests.log | sort | uniq -c | sort -rn | head`
     (`eth_getBlockReceipts` should drop sharply after 1a ships).
2. **Record a baseline** from the dashboard for one week: fallback count per method,
   per-node timeout rates (`/nodeTimeoutPercentLastWeek`), Alchemy compute-unit
   usage from Alchemy's dashboard.
3. **Confirm production `TARGET_URL`** is `pool.mainnet.rpc.buidlguidl.com:48544`
   (this machine's `.env` points at stage).
4. **Lock decisions D1–D9.**

Done when: the per-method fallback counts and the pool's Socket.IO options are
recorded in the results file's "To confirm" list.

---

## Phase 1: Transport and safety fixes (no keys yet; fixes today's traffic)

These are independent of the key system and should ship first. They reduce the
fallback bill and node disconnects immediately.

### 1a. bg-rpc-pool: Socket.IO server options

File: `pool.js` (~line 170, `new Server(wsServer, {...})`).

- `maxHttpBufferSize: 64e6` (64 MB). This is a per-message ceiling, not a
  reservation: memory is used only by messages that actually arrive, so headroom is
  free. Exceeding it **disconnects the node** (the 1 MB failure in miniature), so it
  must sit well above any legitimate response, including ones not measured
  (`eth_simulateV1` return data, large `eth_call` results). It must also be strictly
  larger than the node client's `maxContentLength` (1b, 32 MB), so an oversized
  response always surfaces there as a JSON-RPC error with the socket intact, and
  this limit only ever catches something that bypassed the client cap. 64 MB keeps
  the blast radius of a single rogue message (buffer + parsed objects, ~5–10× the
  JSON size, on one event loop) survivable. The limit applies to the *uncompressed*
  size.

  Size-cap hierarchy, outermost to innermost: reth `--rpc.max-response-size`
  160 MB (default) > pool 64 MB > node client 32 MB > edge getLogs response cap
  20 MB. Each is ≥ 2× the one inside it.
- `perMessageDeflate: { threshold: 1024 }`. The node clients already offer it.
  Measured 9–10× on logs and receipts.
- Memory note: each connection keeps a zlib context; with ~16 nodes this is
  negligible.

Done when: a direct `eth_getBlockReceipts` for a busy block through the pool returns
data and the serving node stays connected. Pool logs show no `timeout_error` for
receipts.

Rollback: revert the two options.

### 1b. buidlguidl-client: bound the node-side RPC call

File: `webSocketConnection.js` (~line 174, the `axios.post("http://localhost:8545")`
in the `rpc_request` handler).

- Add `timeout` (per method: **4 s** for getLogs / filter methods, **2.5 s**
  otherwise; each below the pool's timeout for that method) and
  `maxContentLength: 32e6`. This is the cap that carries the size policy for node
  responses: it's half the pool's 64 MB Socket.IO limit, so an oversized response
  always becomes a JSON-RPC error here, never a disconnect there. Today the call has
  neither option, so a slow or oversized response is only ever cut off by the pool's
  timeout or the Socket.IO size limit.
- On either limit, reply with a JSON-RPC error (code `-32603`, message naming the
  limit) instead of hanging. The pool then gets an error, not a timeout, so the
  node's timeout rating isn't hurt.

Done when: an oversized or slow request against a client build returns the error
within the timeout.

### 1c. bg-rpc-proxy: batch cap and method-aware fallback

Files: `utils/validateRpcRequest.js`, `proxy.js` (`processSingleRequest`, ~lines
215–335), `config.js`.

- **Batch cap:** reject arrays longer than `maxBatchLength` (default **50**) with
  `-32600 "Batch too large (max 50)"`. Today a batch of 1,000 is accepted and run
  sequentially.
- **No fallback for heavy methods:** add `methodsNeverFallback = ['eth_getLogs',
  'eth_newFilter', 'eth_getFilterLogs', 'eth_getFilterChanges']` in `config.js`. In
  `processSingleRequest`, when the pool result is a failure (including the `-69008`
  timeout and `-69005`/`-69006` node timeouts) and the method is in that list, return
  the pool's error to the caller instead of calling `handleRequest(..., 'fallback')`.
  Today only errors whose code is in `ignoredErrorCodes` skip the fallback; timeouts
  never do.
- **Per-method pool timeout:** replace the single `poolRequestTimeout` (15 s) with a
  map; getLogs and filter methods **8 s**, default stays 15 s.
- **Telegram:** don't alert on failures for methods in `methodsNeverFallback` (the
  edge proxy will report key-level problems); today every failure alerts with the
  full body. `utils/telegramUtils.js` already suppresses alerts for codes in
  `ignoredErrorCodes`; extend the same check to the method list.
- **Expose getLogs readiness to the edge.** Add `GET /getlogsStatus` to the
  **public** Express app (the one on 48544, next to `/watchdog`), proxying the pool's
  new `/getlogsStatus` (Phase 3, item 7). The edge can only reach 48544 (that is
  what `TARGET_URL` points at); the pool's 3003 and bg-rpc-proxy's 3002 are the
  downstream machine's internal ports, used by bg-rpc-web-server on the same host.
- Housekeeping while there: read `server.cert`/`server.key` once at startup in
  `utils/handleRequest.js` instead of `fs.readFileSync` per request.

Done when: a getLogs that times out at the pool produces **zero** lines in
`fallbackRequests.log` and the caller receives a JSON-RPC error.

Rollback: empty `methodsNeverFallback`, restore `maxBatchLength` to a large number.

### 1d. Edge proxy (this repo): hygiene that the key work depends on

Files: `proxy.js`, `utils/requestValidator.js`.

- **Batch cap:** same rule as 1c (**50**), enforced in `validateRpcRequest`, so it's
  the first layer to reject.
- **Never return plain text.** The catch block at `proxy.js` ~lines 293–301 does
  `res.status(...).send(error.message)`. Replace with a JSON-RPC error (`-32603`,
  `id` from the request) and HTTP 200, matching every other error path.
- **Header allowlist upstream.** `makePrimaryRequest` spreads all client headers
  (`proxy.js` ~line 131). Forward only `Content-Type`, `User-Agent`, and `Origin`
  (the pool logs use origin). This is a prerequisite for keys: bg-rpc-proxy forwards
  headers to the fallback, so an `X-Api-Key` would reach Alchemy.
- **Stop logging response bodies** on the immediate-fallback path (`proxy.js` ~line
  280).
- **Remove `/status` from unauthenticated routes** or strip anything sensitive before
  adding key data to it in Phase 4.

Done when: `curl` with a bogus header shows it absent at bg-rpc-proxy's log; a forced
upstream error returns JSON-RPC.

### 1e. Compression on every network hop

Test 12 measured **9–10× on logs and receipts, ~5× on full blocks**, for tens of ms
of CPU. Three hops cross a network today and none compresses:

| Hop | Where to enable | Mechanism |
|---|---|---|
| node → pool (volunteer upload; the slowest link) | Phase 1a | Socket.IO `perMessageDeflate` (server side; node clients already offer it) |
| bg-rpc-proxy → edge (downstream machine → this AWS host; every keyed getLogs response crosses it) | bg-rpc-proxy `proxy.js`, the public `app` | Express `compression()` middleware with `threshold: 1024`. The edge's axios sends `Accept-Encoding: gzip, deflate, br` by default and decompresses transparently; this only starts working once Phase 1d stops the edge from forwarding the client's own `Accept-Encoding` header upstream. |
| edge → client | this repo `proxy.js`, after `bodyParser.json()` | Express `compression()` with `threshold: 1024`. Browsers and Node clients negotiate it automatically. |

Not needed: bg-rpc-proxy → pool (`/requestPool`) is localhost on the downstream
machine.

Policy (applies to all three hops):
- **Select by size, not by method.** `threshold: 1024` bytes; responses under it are
  sent as-is. Most traffic (`eth_call` ~100 B, `eth_blockNumber`) never touches zlib.
  No per-method lists: size is the better discriminator and needs no maintenance.
- **Level 1** (`zlib.constants.Z_BEST_SPEED`). Test 12: level 1 kept ~92% of level
  6's savings (1.02 MB vs 0.94 MB from 8.9 MB) at about half the CPU (~2.3 ms/MB vs
  ~5 ms/MB, off the event loop on the thread pool).
- **No custom opt-in/opt-out.** HTTP hops negotiate per request via
  `Accept-Encoding`; Socket.IO negotiates per connection at the handshake. Clients
  that don't ask for compression get plain JSON with no extra code.
- Memory: ~300 KB per active stream (transient for HTTP; per connection for
  Socket.IO, so a few MB for ~16 nodes). Negligible next to the 50–100 MB a large
  parsed response already costs each process.

What it does and doesn't fix: an 8.9 MB getLogs response takes 7.1 s to send at
10 Mbps raw and 0.75 s compressed, so the volunteer-upload and inter-host transfer
costs mostly disappear. **Memory and JSON parsing are unchanged**: every process
still inflates, parses and re-serializes the full uncompressed body, which is why D2
keeps the log cap at 10k rather than the 20k default. Compression also doesn't
bypass the Socket.IO size limit (`ws` checks the inflated size), so 1a's
`maxHttpBufferSize` is still required.

Done when: `curl -H 'Accept-Encoding: gzip' --compressed -v` against the edge and
against bg-rpc-proxy's 48544 both show `Content-Encoding: gzip` on a getLogs-sized
response, and the pool's Socket.IO handshake log shows `permessage-deflate`
negotiated with nodes.

---

## Phase 2: Node flags and check-in fields (buidlguidl-client release)

Files: `ethereum_clients/reth.js` (the launcher args array), `webSocketConnection.js`
(check-in payload, ~lines 285–310).

### 2a. Reth flags

Add to the reth args:
- `--rpc.max-blocks-per-filter 10000` (D1 backstop; default 100,000)
- `--rpc.max-logs-per-response 10000` (D2; default 20,000)

These apply to every getLogs on the node, including direct local use by the
operator. Both are backstops; the edge enforces the same limits first.

### 2b. Check-in additions

Add to the `checkin` payload:
- `receipt_floor`: the node's L. Compute once at startup by the 19-call binary search
  on `eth_getBlockReceipts` used in test 0 (bounds: head − 1,200,000 … head), then
  once a day. Report `null` until known.
- `getlogs_ready: true` when this client version applied the flags in 2a. The pool
  routes getLogs only to nodes that report it, so an unupgraded node never receives
  getLogs. This avoids version-sniffing `execution_client`.

Pool side of the same change: the check-in handler (`pool.js` ~line 634) already
stores every check-in field via `{ ...existingClient, ...params }`, so no change is
needed to persist them. But `utils/getPoolNodesObject.js` **whitelists** the fields
it exposes on `/poolNodes`; add `receipt_floor` and `getlogs_ready` there.

Done when: the pool's `/poolNodes` shows `receipt_floor` and `getlogs_ready` for
upgraded nodes.

Rollout: ship as a client release; nodes pick it up as operators update. Phase 3
routing tolerates a mix.

---

## Phase 3: Pool routing for getLogs

Files: `config.js`, `utils/selectRandomClients.js`, `utils/handleRequestSingle.js`,
`pool.js` (`/requestPool` handler, ~lines 416–470).

Keep today's selection for every other method. Add a narrow path for getLogs and the
filter methods, driven by one config object rather than more branches:

```js
// config.js
const heavyMethods = {
  eth_getLogs:          { timeout: 5000, retry: false, compare: false, maxPerNode: 4 },
  eth_getFilterLogs:    { timeout: 5000, retry: false, compare: false, maxPerNode: 4 },
  eth_newFilter:        { timeout: 3000, retry: false, compare: false, maxPerNode: 4 },
  eth_getFilterChanges: { timeout: 3000, retry: false, compare: false, maxPerNode: 4 },
};
```

Changes:
1. **Eligibility filter for heavy methods** (in `selectRandomClients`, applied
   *before* the head-block step, so a reth-only set can't come up empty because a
   geth node is one block ahead):
   - `execution_client` starts with `reth`
   - `getlogs_ready === true`
   - `receipt_floor` is known and `≤ fromBlock` (resolve `latest`/`safe`/
     `finalized`/`earliest` first; `pending` is rejected)
   - in-flight heavy count for the node `< maxPerNode`
2. **No second-node retry, no 3-node comparison** for heavy methods
   (`handleRequestSingle` retries only when `retry` is true; heavy methods never take
   the `handleRequestSet` path).
3. **Per-node in-flight counter**, keyed by node `id` (not socket id, which changes
   on reconnect). Increment on send. **Decrement on response or disconnect, not on
   timeout**: the node keeps working after a timeout (test 7), and the pool already
   receives late responses (it ignores them today; use that callback to decrement).
4. **No eligible node** → return `-32005 "getLogs capacity exhausted, retry shortly"`
   immediately. bg-rpc-proxy passes it through (Phase 1c).
5. **Add `eth_getLogs` to `methodsToSkipComparison`.** The three filter methods are
   already in it (`config.js` ~lines 54–56); `eth_getLogs` is not, which is why 1 in
   20 getLogs runs on three nodes today.
6. **Log line:** one line per heavy request decision with candidate counts after each
   filter (`16 → 13 reth → 11 ready → 9 covers range → 7 with capacity → picked X`).
7. **`GET /getlogsStatus`** on the pool's internal API (port 3003, next to
   `/poolNodes`): `{ readyNodes, receiptFloor, inFlight }` where `receiptFloor` is the
   **maximum** `receipt_floor` over ready reth nodes. bg-rpc-proxy proxies it to the
   edge (Phase 1c).
8. **Keep heavy-method timeouts out of node ratings.** bg-rpc-logs computes a node's
   timeout rate by exact match on the status string `timeout_error` in
   `poolNodes.log` (`utils/metricsCalculators.js` ~line 430); it doesn't look at the
   method. Have `handleRequestSingle` log heavy-method timeouts as
   `timeout_error_heavy` instead. They then stop counting against a node's routing
   rating with **no change to bg-rpc-logs**, and remain visible in the log viewer.

Done when: with one upgraded reth node and one geth node at the same head, a getLogs
through the pool always lands on the reth node, and the 5th concurrent getLogs to a
single node is rejected with `-32005`.

Rollback: set `heavyMethods` to `{}`; routing falls back to today's path.

---

## Phase 4: Edge proxy: keys, policy, metering

All in this repo. New files under `utils/`, wiring in `proxy.js`, settings in
`config.js`, tables via `database_scripts/`.

### 4a. Data model (Postgres, `database_scripts/createApiKeyTables.js`)

```sql
CREATE TABLE api_keys (
  id            SERIAL PRIMARY KEY,
  key_hash      CHAR(64) UNIQUE NOT NULL,      -- sha256 of the key
  key_prefix    VARCHAR(12) NOT NULL,          -- first 8 chars, for display
  owner         TEXT NOT NULL,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- active | revoked
  limits        JSONB NOT NULL DEFAULT '{}',   -- per-key overrides (see below)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);
CREATE TABLE api_key_usage (
  key_id        INT REFERENCES api_keys(id),
  bucket_hour   TIMESTAMPTZ NOT NULL,
  method        TEXT NOT NULL,
  calls         INT NOT NULL DEFAULT 0,
  units         INT NOT NULL DEFAULT 0,
  errors        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket_hour, method)
);
```

Default limits (in `config.js`, overridable per key in `limits`):

```js
const apiKeyDefaults = {
  unitsPerHour: 50000,
  unitsPerDay: 500000,
  concurrency: 2,
  maxBlockRange: 10000,
};
```

Key format: `bg_` + 32 random bytes, base64url. Only the hash is stored. Generation
and revocation via `database_scripts/manageApiKeys.js` (create / revoke / list) and
the admin endpoints in 4f.

### 4b. Key loading and lookup (`utils/apiKeys.js`)

- Load all `active` rows into a `Map<key_hash, keyRecord>` at startup; refresh every
  **30 s** (same pattern as `startRateLimitPolling`). Fail-closed on a cold start:
  until the first load succeeds, every keyed request gets `-32001`.
- `POST /admin/keys/reload` (behind `requireAdminKey`) forces a refresh for instant
  revocation.
- Lookup: sha256 the presented key, `Map.get`. No per-request DB access.
- Extract the key from `X-Api-Key`, `Authorization: Bearer …`, or the path
  `/v1/<key>` (add `app.post('/v1/:key', …)` sharing the handler with `/`).
- **Redaction.** Nothing in this repo logs the request path today: the only uses
  of `req.path` are in `utils/adminAuth.js` (admin routes, which never carry a key),
  and `utils/rejectLogger.js` records ip / origin / method / reason, not the URL.
  Downstream can't see the path either: the edge posts to `TARGET_URL`'s root, and
  bg-rpc-proxy's `utils/logRequest.js` logs origin / referer / host, never the
  path. So the only rule is for **new** code: the `/v1/:key` handler must never log
  `req.originalUrl` or `req.params.key`; log the key's `key_prefix` instead. Headers
  are covered by the Phase 1d allowlist.

### 4c. Request pipeline (`proxy.js`, `app.post`)

Order, replacing the current inline getLogs block at ~lines 187–199:

1. IP blacklist (unchanged; applies to keyed traffic too).
2. `validateRpcRequest` (unchanged, plus the batch cap from Phase 1d).
3. **Key resolution.** Key present and invalid/revoked → HTTP 401, JSON-RPC
   `-32001 "invalid or revoked API key"`. No key → anonymous.
4. **Anonymous path:** unchanged rate limiter. If any item in the body is a getLogs or
   filter method (D9) → `-32601 "eth_getLogs requires an API key; see <docs url>"`,
   HTTP 200, **no `Retry-After`** (today's 429 makes clients retry forever).
5. **Keyed path:**
   - skip the IP/origin limiter
   - for each getLogs / filter item: `validateGetLogs` (4d)
   - per-key concurrency (`concurrency`, in-flight counter keyed by key id) and the
     global edge cap (`getLogsGlobalInFlight`, **16**) → `-32005 "capacity"` with HTTP
     429 and `Retry-After: 2`
   - quota check (4e) → `-32005 "quota exceeded"` with HTTP 429 and `Retry-After`
     to the window boundary
   - **charge before forwarding** (4e)
   - forward with a 12 s timeout, `maxContentLength` 20 MB, and **without** the
     circuit breaker's `onFailure`/fallback path (`makePrimaryRequest` takes a flag;
     on error return `-32603` to the caller)
6. Response handling unchanged otherwise.

Feature flag: `GETLOGS_KEYS_ENABLED` (env). When false, step 5 behaves like step 4
for everyone, i.e. today's block. This is the rollback switch.

### 4d. getLogs validation (`utils/getLogsPolicy.js`)

Input: one JSON-RPC item. Applies to `eth_getLogs` and `eth_newFilter` (the filter
object) and, for `eth_getFilterLogs` / `eth_getFilterChanges`, passes through (the
node owns the filter; the pool caps them by count).

Checks, in order, each producing a `-32602` error with Alchemy-style wording:
1. `blockHash` filter → allowed, cost = 1 block, skip range checks.
2. Resolve tags using a cached head: the edge sends `eth_blockNumber` to
   `TARGET_URL` every 12 s. That request never reaches a node: bg-rpc-proxy serves
   `eth_blockNumber` from its cache (`utils/handleCachedRequest.js`), which the pool
   pushes over WebSocket on every node check-in (`utils/updateCache.js`,
   `broadcastUpdate`). Note bg-rpc-proxy's own `transformLatestToBlockNumber`
   (`proxy.js` ~line 39) rewrites only **top-level** `"latest"` params and leaves a
   getLogs filter object untouched, so the edge must resolve getLogs tags itself.
   `pending` → reject. Missing `fromBlock` defaults to `latest`.
3. `from > to` → reject (reth also rejects; reject here to avoid the round trip).
4. `to − from + 1 > maxBlockRange` → reject with:
   `Log request range too large. You can request up to 10000 blocks per call. Try [0x<from>, 0x<from+9999>].`
5. `from < receiptFloor` → reject with:
   `Logs older than block <floor> are not available on this endpoint (history is ~100 days).`
   `receiptFloor` comes from `GET <TARGET_URL host>:48544/getlogsStatus` (Phase 1c /
   Phase 3 item 7), polled every 60 s. Fail closed: until the first successful poll,
   keyed getLogs returns `-32603 "getLogs not ready"`. `RECEIPT_FLOOR_OVERRIDE`
   (env) pins the value for staging or emergencies and is the only manual path.
6. Address list length ≤ 10, topic positions ≤ 4 (sanity; reth handles the rest).

Output: `{ ok, error, blockCount }`. `blockCount` feeds metering.

### 4e. Metering and quotas (`utils/apiKeyMeter.js`)

- Units per call: `5 + ceil(blockCount / 100)` (D4). Non-getLogs methods on a keyed
  request: use `methodRequestCounts` from `config.js` (default 1).
- In-memory per-key counters: `{ hourUnits, dayUnits, inFlight }`. Hour and day
  windows are fixed UTC buckets (simpler than sliding; matches Alchemy's monthly-CU
  model well enough).
- **Startup baseline:** on load, sum `api_key_usage` for the current hour and day per
  key so a restart doesn't reset quotas.
- **Flush:** every 10 s in `processBackgroundTasks` (`utils/backgroundTasks.js`),
  upsert per `(key_id, bucket_hour, method)`; on failure keep the counts and retry,
  same as `restoreIpCounts`.
- Errors after admission (node error, timeout) still count as charged (the work was
  done, test 7) but increment `errors`.

### 4f. Admin endpoints (all behind `requireAdminKey`)

- `GET /admin/keys` → list (prefix, owner, label, status, limits, last_used_at)
- `POST /admin/keys` → create; returns the plaintext key **once**
- `POST /admin/keys/:id/revoke`
- `POST /admin/keys/reload`
- `GET /admin/keys/usage?hours=24` → per-key units/calls/errors from memory + DB
- `GET /admin/getlogs/status` → in-flight counts, receipt floor, head cache age,
  feature flag state

### 4g. Error catalog (edge)

| Situation | HTTP | code | message |
|---|---|---|---|
| getLogs without key | 200 | `-32601` | requires an API key + docs URL |
| bad/revoked key | 401 | `-32001` | invalid or revoked API key |
| range too large | 200 | `-32602` | Alchemy-style + suggested range |
| below receipt floor | 200 | `-32602` | history limit |
| bad params | 200 | `-32602` | pass through reth's message when it originated there |
| per-key / global capacity | 429 | `-32005` | capacity, `Retry-After: 2` |
| quota exceeded | 429 | `-32005` | quota, `Retry-After` to window |
| chain failure / timeout | 200 | `-32603` | internal error; never plain text |

Done when: the test scripts from `RETH_TEST_SCRIPTS_ADDENDUM.md` (tests 1, 2, 5, 18)
pointed at the edge with a key reproduce the expected caps and errors; anonymous
getLogs returns `-32601`; `fallbackRequests.log` shows no getLogs; `/admin/keys/usage`
matches the calls made.

---

## Phase 5: Observability

- **bg-rpc-web-server:** add `routes/apikeys.js` (session-protected like the
  others; the login middleware in `webServer.js` exempts only `/watchdog`,
  `/yournodes`, `/nodecontinents`, `/rpcsitestats`). It calls the edge's
  `/admin/keys` and `/admin/keys/usage` exactly as `routes/ratelimitstatus.js` does:
  base URL from `process.env.RPC_PROXY_HOST`, header `X-Admin-Key` from
  `process.env.RPC_PROXY_ADMIN_KEY` (both already configured for the existing rate
  limit and blacklist pages). Show per-key units this hour/day, errors, last used,
  and a revoke button (POST to the edge). Add the nav link in `webServer.js` next
  to "Rate Limits".
- **bg-rpc-logs:** nothing required; heavy methods already appear in
  `poolRequests.log` and `poolNodes.log` by method name. Optional: a
  `/methodTimeoutRates` endpoint so the dashboard can show timeout rate per method.
- **Alerts (edge, Telegram):** one alert when a key hits its daily quota; one when
  global in-flight stays at cap for > 60 s. Rate-limit alerts to one per key per
  hour.
- **Results-file updates:** move confirmed items from "To confirm" to "Answered" as
  Phase 0/1 data comes in.

---

## Phase 6: Rollout

1. **Staging first.** This machine's `.env` already targets stage. Run Phases 1–4
   against stage with `GETLOGS_KEYS_ENABLED=true` and 2 test keys. Run the test-script
   suite through the edge. Run test 6's concurrency shape (N = 1, 2, 4, 8) through the
   full chain with one key at `concurrency: 8` to confirm the pool's per-node cap and
   the edge's global cap behave.
2. **Production, keys off.** Deploy Phases 1, 1d and 4 with `GETLOGS_KEYS_ENABLED=false`.
   Behavior for users is unchanged except the anonymous getLogs error text. Watch the
   Phase 0 baseline metrics for a week: fallback count per method should drop,
   node timeout rates should drop.
3. **Enable for 2–3 trusted holders** with default limits. Watch `/admin/keys/usage`,
   Alchemy CU usage (should not rise), pool node disconnects (should be zero).
4. **Widen** issuance (D6 remains manual). Raise per-key defaults only with data.

Rollback at any step: `GETLOGS_KEYS_ENABLED=false` at the edge restores the full
block; Phase 1 changes stay (they are independently beneficial).

---

## Phase 7: Later options (not in scope now)

- **Load-aware routing for all methods** (results file, "Pool routing design"):
  Phase 3's per-node heavy counter is the first piece; the full profile table and
  power-of-two selection come after Phase 6 has run quietly.
- **Raise the range cap toward 100k** (Alchemy gap 1) once per-node caps and nested
  timeouts have held for a while; requires pool timeout ≥ 12 s for getLogs.
- **Serve ranges below the receipt floor from Alchemy** (Alchemy gap 2), with its own
  cap and metering, via a `methodsFallbackAllowedWithKey` list in bg-rpc-proxy.
- **Reweight other heavy methods** (`eth_feeHistory`, `eth_getProof` key-count cap,
  execution methods) per the results file's future-work section.
- **Automated issuance** (sign-in, payment) if manual issuance becomes a bottleneck.

---

## Cross-repo change summary

| Repo | Phase | Files |
|---|---|---|
| bg-rpc-pool | 1a, 2b, 3 | `pool.js` (Socket.IO options, `/getlogsStatus` route), `config.js`, `utils/selectRandomClients.js`, `utils/handleRequestSingle.js` (no retry for heavy methods, `timeout_error_heavy` status), `utils/getPoolNodesObject.js` (expose `receipt_floor`, `getlogs_ready`) |
| buidlguidl-client | 1b, 2 | `webSocketConnection.js`, `ethereum_clients/reth.js` |
| bg-rpc-proxy | 1c, 1e | `proxy.js` (batch/fallback logic, `/getlogsStatus` proxy route, `compression()`), `config.js`, `utils/validateRpcRequest.js`, `utils/handleRequest.js`, `utils/telegramUtils.js`, `package.json` (add `compression`) |
| rpc-ssl-proxy (edge) | 1d, 1e, 4, 5 | `proxy.js`, `config.js`, `package.json` (add `compression`), `utils/requestValidator.js`, `utils/backgroundTasks.js` (usage flush), new `utils/apiKeys.js`, `utils/getLogsPolicy.js`, `utils/apiKeyMeter.js`, `database_scripts/createApiKeyTables.js`, `database_scripts/manageApiKeys.js`, `.env.example` |
| bg-rpc-web-server | 5 | new `routes/apikeys.js`, nav link in `webServer.js` |
| bg-rpc-logs | — | no change: heavy timeouts are excluded by the status string (Phase 3 item 8), and edge-generated errors never reach it |
| shared (downstream machine) | 3 | `shared/ignoredErrorCodes.js`: add **`-32005`** so the pool's capacity rejection (Phase 3 item 4) is not counted as a failure by bg-rpc-logs, not alerted by bg-rpc-proxy, and (belt and braces with 1c) never sent to the fallback. The edge's own codes (`-32601`, `-32001`, its `-32005`) are produced before forwarding and never appear downstream. |

## Test plan (reuse existing scripts)

- Unit: `getLogsPolicy` (tags, range, floor, blockHash, malformed), `apiKeyMeter`
  (units formula, window rollover, baseline load), `apiKeys` (hash lookup, reload,
  fail-closed).
- Integration on stage: `RETH_TEST_SCRIPTS_ADDENDUM.md` tests 1, 2, 5, 11, 18 with
  `--url` set to the edge and an `--api-key` flag added to the scripts; expected
  results per the error catalog. Test 6 at N ≤ 8 through the chain.
- Negative: anonymous getLogs, revoked key, batch of 51, `/v1/<key>` in logs
  redacted, `X-Api-Key` absent at bg-rpc-proxy.

## Risks

- **Pool nodes on old client versions** never get getLogs (by design); if too few
  upgrade, capacity is low. Mitigation: the `/admin/getlogs/status` endpoint shows
  ready-node count; hold rollout until ≥ 5.
- **Receipt floor varies per node.** Using the maximum L across ready nodes is
  conservative; a node with a deeper floor is simply never asked for older ranges.
- **Quotas in fixed UTC buckets** allow a 2× burst at the boundary. Acceptable at
  these sizes; the concurrency caps bound the instantaneous load regardless.
