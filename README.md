# bg-rpc-ssl-proxy

The public HTTPS entry point for BuidlGuidl's RPC service. This process **sits upstream of the main RPC machine**: it terminates TLS on port 443, filters and meters every incoming JSON-RPC request, and forwards the survivors to the pool running on the main RPC machine. If that machine is unhealthy it fails over to a third-party provider so users keep getting answers.

Everything that protects the main RPC machine from the public internet lives here.

---

## Read this first: the naming is confusing

There are two services with "proxy" in the name and they are **not** the same thing. They run on different machines and do different jobs.

| Service | Machine | Position | What it is |
| --- | --- | --- | --- |
| **`bg-rpc-ssl-proxy`** | its own box | **upstream** | **This repo.** Public TLS endpoint, request validation, rate limiting, failover. |
| `bg-rpc-proxy` | main RPC machine | **downstream** | A different proxy, one hop *behind* this one. |
| `bg-rpc-pool` | main RPC machine | downstream | The node pool that actually serves RPC results. |
| `bg-rpc-web-server` | main RPC machine | downstream | Web server / dashboard. |

Traffic flows in one direction:

```
public internet
      |
      v
bg-rpc-ssl-proxy        <-- THIS REPO (upstream, own machine)
      |
      v
main RPC machine        <-- bg-rpc-proxy, bg-rpc-pool, bg-rpc-web-server
```

If the main RPC machine can't be reached, this process routes to `FALLBACK_URL` (a third-party provider such as Infura or Alchemy) instead.

The repository and directory are named `rpc-ssl-proxy`; the pm2 process is named `proxy`. Same thing.

---

## What this process does

Nine distinct duties, described in the order a request encounters them.

### 1. Terminate TLS and serve the public endpoint

Runs an HTTPS server on **port 443** using `server.key` / `server.cert`, which are Let's Encrypt certificates copied into the project root by `le.sh`. CORS is wide open, since the callers are browser dApps on arbitrary origins.

Nothing sits in front of this service, so `trust proxy` is deliberately set to `false` and `X-Forwarded-For` is ignored entirely. The client IP is always the address observed on the socket — a peer has to complete a TCP and TLS handshake to get here, so that address can't be forged, whereas forwarding headers are free-form caller input. Rate limit counters are only meaningful when keyed on an identity the caller cannot mint at will.

### 2. Validate JSON-RPC requests

The body is parsed as JSON whatever the `Content-Type` says (so `curl -d` without a header and browser `fetch` with a string body both work), up to `maxRequestBodySize` in `config.js` (**4 MB**, the same as bg-rpc-proxy's limit, so an oversized body is refused here and never becomes a downstream failure). Body errors are answered as JSON-RPC, not HTML: over the limit → HTTP 413 with `-32600`, unparseable → HTTP 400 with `-32700`.

`utils/requestValidator.js` then runs as global middleware and rejects malformed work before it can reach the main RPC machine. It handles both single requests and batch arrays, and checks that `jsonrpc` is `"2.0"` and that `method` and `id` are present. In a batch, each invalid item is answered on its own, at its position, with its own `id`; the valid items are processed normally and the answers are merged back in order (`utils/batchMerge.js`, shared with the disabled-method check). An empty batch, or one over 50 items, gets a single `-32600`.

It also blocks dangerous namespaces outright:

```
admin_  personal_  debug_  miner_  engine_  clique_  les_
```

These cover node management, wallet and key access, internal state dumps, mining control, and consensus-layer communication — none of which should be reachable from the public internet.

Rejections return **HTTP 200** with a JSON-RPC error body: `-32700` for an empty body, `-32600` for a structurally invalid request, `-32601` for a blocked namespace (per item inside a batch). If the validator itself throws, it fails **open** and lets the request through rather than taking the service down.

### 3. Block blacklisted IPs

`utils/ipBlacklist.js` reads `ip_blacklist.txt` (one IP per line, `#` comments supported) into an in-memory set and re-reads it automatically when the file changes, polling every 5 seconds. No restart needed to ban someone.

This is the very first check in the request handler. Blacklisted IPs get a 429 with the plain `-32005 Rate limit exceeded.` body (deliberately without the detail a real limit carries, see section 5), so the blacklist isn't distinguishable from the outside. The check fails open on error.

### 4. `eth_getLogs` policy

Log range scans are expensive enough to degrade the pool on their own, so `eth_getLogs` is the one method with its own admission policy (plan Phase 4, `bg-rpc-docs`). Today it is behind a switch: with `GETLOGS_KEYLESS_STAGE` unset, every `eth_getLogs` item is answered `-32601 eth_getLogs is not available on this endpoint` at its position (HTTP 200, no `Retry-After`, no units; the rest of a batch is processed normally) and none is forwarded. With the switch on, getLogs is served without an API key through the policy path below. The process refuses to start with the switch on unless `TARGET_URL` is a stage host or localhost, so it can't be left on in production by accident; API keys will replace it.

The filter methods (`eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter`, `disabledMethods` in `config.js`) are off regardless: a filter id exists only on the node that created it, so follow-up calls fail once there is more than one node. They are answered right after validation with `-32601 <method> is not supported on this endpoint; use eth_getLogs`, per item in a batch, before anything else runs.

**Policy path** (`utils/getLogsPolicy.js`, after the blacklist and rate-limit checks). Each getLogs item is validated on its own: the filter may be positional (`params[0]`) or by name (`params.filter`); `fromBlock`/`toBlock` tags (`latest`, `safe`, `finalized`, `earliest`) resolve against the cached head and `pending` is refused; a `blockHash` filter counts as one block; the range may cover at most **10,000 blocks** (`-32602` with a suggested range, the convention libraries split on); `fromBlock` may not be below the pool's receipt floor (`-32602`); at most 10 addresses and 4 topics. A batch may hold at most **5** getLogs items; the rest get `-32602` at their position. Every refused item is answered at its position with its own id, costs no rate-limit units and takes no capacity; the other items in the batch are processed normally.

**Chain state.** Two pollers feed the checks: `eth_blockNumber` to bg-rpc-proxy every 12 s (the head) and `GET /getlogsStatus` every 60 s (the lowest `receipt_floor` among the pool's ready getLogs nodes, plus how many are ready). A head older than 120 s or a floor older than 600 s counts as unknown. The policy fails closed: while either is unknown, getLogs answers `-32005 eth_getLogs is temporarily unavailable, retry shortly`, or `…: no node can serve it right now, retry shortly` when the pool reports zero ready nodes. The poll errors go to the log and `/status`, not to the caller. `RECEIPT_FLOOR_OVERRIDE` pins the floor for emergencies and is the only manual path. Both polls carry `Origin: buidlguidl-client` so downstream stats count them as internal traffic.

**Capacity and forwarding.** The edge allows **16** getLogs items in flight at once; each accepted item takes one slot, and a request that doesn't fit gets HTTP 429 with `-32005 getLogs capacity exhausted at the edge, retry shortly` and `Retry-After: 2`. Accepted items go to bg-rpc-proxy on their own path, each as a single upstream request (a batch's items in parallel, since bg-rpc-proxy would run them one after another), with a 12 s timeout and a 20 MB response cap, no circuit breaker and no fallback: a getLogs failure comes back as `-32603` for that item, never as a retry on the paid provider. Served items count `1 + ⌈blocks / 1000⌉` units (section 5). `/status` shows the getLogs state: head, floor, ready nodes, in flight, and the last poll errors.

### 5. Rate limit

`utils/rateLimiter.js` enforces a two-tier limit with two separate buckets.

**Buckets.** Requests carrying a real public origin (a deployed dApp) are metered against that origin. Requests with no origin, a localhost origin, or a private-IP origin are metered against the client IP, on the assumption that they're individual developers. The `buidlguidl-client` origin is exempt and is never counted. Because `Origin` is a caller-set header, that exemption is held to the two calls the buidlguidl clients actually make: `eth_blockNumber`, and `eth_call` to the ENS Universal Resolver (addresses in `exemptOriginCallTargets`, `config.js`) with no state-override param. Anything else sent with that origin gets `-32601 Method not supported from this origin` from the validator, per item in a batch, before rate limiting or forwarding.

**Tiers.** An hourly sliding window plus a daily hard cap. The sliding window blends the current and previous hour (`current + previous × weight`, where the weight decays from 1.0 to 0 across the hour) so callers can't burst across an hour boundary. Current limits, all in `config.js`:

| Bucket | Per hour | Per day |
| --- | --- | --- |
| Origin (deployed app) | 4,000 | 40,000 |
| IP (no origin) | 1,000 | 5,000 |

**Weights.** Limits are denominated in weighted units, not raw calls, using the shared request cost table in `utils/requestUnits.js` (the same units the RPC pool uses for load balancing and API-key metering will use): `eth_getLogs` counts 1 + ⌈blocks / 1000⌉ (2 for up to 1,000 blocks, 11 for the 10,000 cap; a `blockHash` filter is 1 block), `eth_getBlockReceipts`, `eth_getBlockByNumber` and `eth_getBlockByHash` count 2, `eth_feeHistory` counts 1 + ⌈blockCount / 100⌉ (capped at 1,024 blocks), `eth_getProof` counts 1 + ⌈storageKeys / 10⌉, everything else counts 1, and a batch counts the sum of its items.

Enforcement itself is a fast in-memory set lookup on every request. The blocklists behind it are refreshed from Postgres every 10 seconds by a background poll. Limited callers get a 429 with JSON-RPC error `-32005` naming the limit that tripped and when to retry, e.g. `Rate limit exceeded: 1,000 request units per hour for requests without an Origin header; retry in 318 s`, the seconds also in `error.data.retryAfter` and the `Retry-After` header. The check fails open.

**Upstream failures** (`utils/errorMessages.js`, shared by the normal and getLogs paths) are answered as JSON-RPC, HTTP 200: a JSON-RPC error body from bg-rpc-proxy or the fallback is passed through whatever its HTTP status; a timeout says `-32603 Internal error: upstream timed out after 15 s` (`eth_getLogs timed out after 12 s` on the getLogs path); no connection says `-32603 Internal error: upstream unavailable`; a getLogs answer over the size cap says `Internal error: response too large`; anything else keeps `Internal error: upstream request failed`. Internal hosts, ports and provider URLs never appear in an answer.

### 6. Forward upstream, with a circuit breaker

TLS is verified on every outbound connection; nothing in the process turns verification off. The internal hops (bg-rpc-proxy on 48544, its `/getlogsStatus`, the getLogs forwarding path) share one agent, `utils/internalAgent.js`. Today the target presents a public Let's Encrypt certificate; if it ever presents a private one, set `TARGET_CA_FILE` to its PEM and that agent alone trusts it. The fallback provider has its own verifying agent, since its URL carries the API key.

Only two caller headers cross to the next hop, `user-agent` and `origin` (`forwardedHeaders` in `config.js`); everything else, including any `X-Client-IP` a caller sends, is dropped. On requests to bg-rpc-proxy the edge adds its own `X-Client-IP` with the caller's socket address (the same value the rate limiter keys on), so the downstream request logs can record who asked. It is never sent to the fallback provider, and the edge's own head and floor polls carry no client IP.

`utils/circuitBreaker.js` decides where each request goes:

- **CLOSED** — normal, forward to `TARGET_URL` (the main RPC machine).
- **OPEN** — after **2 consecutive failures**, send everything to `FALLBACK_URL` for **60 seconds**.
- **HALF_OPEN** — after that cooldown, try the primary again. Success closes the circuit; failure reopens it.

Independently of the breaker state, any single request that fails against the primary is **immediately retried against the fallback**, so a user-visible error requires both to fail. Requests time out at 15 seconds. Only POST requests affect the breaker — GET requests routinely 404 against RPC endpoints even when the node is perfectly healthy.

### 7. Meter usage into Postgres

`utils/backgroundTasks.js` accumulates per-IP and per-origin request counts in memory, then flushes them to an RDS Postgres instance every 10 seconds via `utils/updateRDSWithIpRequests.js`. This is the data the rate limiter reads back.

It maintains `ip_table` (hourly, daily, and monthly counters plus a JSONB map of per-origin counts) and rolls hourly snapshots into `ip_history_table`, pruning old history. Hourly, daily, and monthly counters are reset on schedule. Origin counts are merged with a custom `jsonb_merge_add_numeric` Postgres function so concurrent updates add rather than overwrite. A failed write restores the counts to the in-memory map so the next cycle retries them.

Database credentials come from **AWS Secrets Manager** (`RDS_SECRET_NAME`), and the connection is TLS-verified against `rds-ca-bundle.pem`.

Only requests successfully served by the **primary** are counted. Fallback responses and failures are deliberately excluded.

### 8. Filter junk origins

`utils/originValidator.js` keeps local and non-public origins out of the database so they aren't tracked as real domains: private IP ranges, `localhost`, origins with ports, browser extensions, local TLDs (`.local`, `.internal`, `.lan`, `.home`), and structurally invalid values.

Critically, the **same classifier decides both how an origin is recorded and which rate limit bucket enforces against it**. If those two ever disagree, an origin can escape both buckets — that gap is what let `Origin: *` bypass rate limiting previously. `testOriginClassifier.js` asserts they stay in lockstep. See `ORIGIN_FILTERING.md`.

### 9. Log rejections and raise alerts

Every rejected request is appended to `requestReject.log` by `utils/rejectLogger.js` — buffered, fire-and-forget, and incapable of blocking or breaking a request.

`utils/telegramUtils.js` sends Telegram alerts to `TELEGRAM_CHAT_IDS` when the circuit breaker opens and again when it recovers.

> **Note:** Firebase donation-ledger updates also live in this process but are currently **disabled** (`firebaseUpdatesEnabled = false` in `config.js`). The `urlList` document exceeded Firestore's per-document index entry cap, so every write failed. Re-enabling requires re-modelling `urlList` as a subcollection. Nothing in the request path reads Firebase, so this does not affect serving or rate limiting.

---

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /` | none | **The RPC endpoint.** Everything above applies to it. |
| `GET /` | none | Passthrough GET to the target. Usually 404s; that's normal for RPC. |
| `GET /watchdog` | none | Health check, returns `{"ok":true}`. |
| `GET /status` | none | Circuit breaker state and configured URLs, as JSON. |
| `GET /proxy` | none | Same information as an HTML page. |
| `GET /methods` | none | In-memory per-method call counts since start. |
| `GET /methodsByReferer` | none | Same, broken down by referer. |
| `GET /letathousandscaffoldethsbloom` | none | Origin traffic leaderboard. |
| `GET /ratelimitstatus` | admin key | Full rate limiter state: per-origin and per-IP counts, blocks, config. |
| `GET /blackliststatus` | admin key | Current IP blacklist contents. |

Admin endpoints require an `X-Admin-Key` header matching `ADMIN_API_KEY`, compared in constant time. If `ADMIN_API_KEY` is unset, those endpoints return 403 rather than falling open.

---

## Configuration

Runtime secrets live in `.env` (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `TARGET_URL` | Primary upstream — the main RPC machine's pool. |
| `FALLBACK_URL` | Third-party provider used when the primary fails. **Contains an API key.** |
| `DB_HOST`, `RDS_SECRET_NAME` | RDS Postgres host and Secrets Manager secret holding its credentials. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | For Secrets Manager. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` | Circuit breaker alerts. Comma-separated chat IDs. |
| `ADMIN_API_KEY` | Guards the admin endpoints. Generate with `openssl rand -hex 32`. |
| `FIREBASE_*`, `GOOGLE_APPLICATION_CREDENTIALS` | Donation ledger. Currently unused (see above). |

Tunable behaviour lives in `config.js`: rate limits, method weights, poll intervals, and the Firebase kill switch. Circuit breaker thresholds are currently set inline in `proxy.js`.

Other files that matter: `ip_blacklist.txt` (hot-reloaded), `server.key` / `server.cert` (TLS), `rds-ca-bundle.pem` (RDS TLS verification), `firebase-service-account.json`.

---

## Operations

The process runs under **pm2 as root**, named `proxy`, because it binds port 443:

```bash
sudo pm2 list
sudo pm2 logs proxy
sudo pm2 restart proxy
```

Logs are in `/root/.pm2/logs/` and rotate daily via `pm2-logrotate`. Rejected requests go to `requestReject.log` in the project root.

Certificates are renewed with `le.sh`, which runs `certbot renew` and copies the result into `server.key` and `server.cert`. The process must be restarted to pick up new certificates.

`database_scripts/` holds the schema migrations and inspection tools — creating `ip_table` and `ip_history_table`, adding the sliding-window / daily / monthly columns, installing the `jsonb_merge_add_numeric` function, and listing or resetting counters. Each has notes in `database_scripts/README.md`.

---

## Known gaps

Worth knowing before you debug something surprising.

- **`/status` and `/proxy` are unauthenticated and echo `FALLBACK_URL` verbatim**, which means they serve the provider API key embedded in it to anyone who asks. `/ratelimitstatus` and `/blackliststatus` are key-protected; these two are not. The circuit breaker's Telegram alerts include the same URL.
- **The circuit breaker treats any upstream rejection as a health failure** — timeouts, 5xx, and 429s all count the same, and it never inspects the response body. With a threshold of 2 and a single global counter shared across concurrent requests, two overlapping slow requests out of hundreds succeeding are enough to move all traffic to the fallback for 60 seconds.
- **Rate limit enforcement lags real traffic by roughly 20–35 seconds.** Requests are only counted after they complete, counts then wait up to 10 seconds for the RDS flush, and the blocklist refresh takes up to another 10. A short concurrent burst can land in full before the limiter reacts.
- **`eth_call` is unweighted** despite being ~90% of dApp traffic and considerably more expensive than the `eth_blockNumber` polls that make up most of the rest.
- **`makePrimaryRequest` forwards all inbound client headers** to the upstream, including `content-length` and `host`. Axios will not overwrite a caller-supplied `content-length`, so a client whose original body serializes to a different length than the re-serialized one can cause a truncated or stalled upstream request. `makeFallbackRequest` builds a clean header set and is not affected.
