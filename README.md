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

`utils/requestValidator.js` runs as global middleware and rejects malformed work before it can reach the main RPC machine. It handles both single requests and batch arrays, and checks that `jsonrpc` is `"2.0"` and that `method` and `id` are present.

It also blocks dangerous namespaces outright:

```
admin_  personal_  debug_  miner_  engine_  clique_  les_
```

These cover node management, wallet and key access, internal state dumps, mining control, and consensus-layer communication — none of which should be reachable from the public internet.

Rejections return **HTTP 200** with a JSON-RPC error body: `-32700` for an empty or unparseable body, `-32600` for a structurally invalid request, `-32601` for a blocked namespace. If the validator itself throws, it fails **open** and lets the request through rather than taking the service down.

### 3. Block blacklisted IPs

`utils/ipBlacklist.js` reads `ip_blacklist.txt` (one IP per line, `#` comments supported) into an in-memory set and re-reads it automatically when the file changes, polling every 5 seconds. No restart needed to ban someone.

This is the very first check in the request handler. Blacklisted IPs get a 429 with the same body a rate-limited caller sees, so the blacklist isn't distinguishable from the outside. The check fails open on error.

### 4. Block `eth_getLogs`

Hard-blocked for every caller. Log range scans are expensive enough to degrade the pool on their own, so they never get forwarded. Returns 429.

### 5. Rate limit

`utils/rateLimiter.js` enforces a two-tier limit with two separate buckets.

**Buckets.** Requests carrying a real public origin (a deployed dApp) are metered against that origin. Requests with no origin, a localhost origin, or a private-IP origin are metered against the client IP, on the assumption that they're individual developers. The `buidlguidl-client` origin is exempt entirely and is never counted.

**Tiers.** An hourly sliding window plus a daily hard cap. The sliding window blends the current and previous hour (`current + previous × weight`, where the weight decays from 1.0 to 0 across the hour) so callers can't burst across an hour boundary. Current limits, all in `config.js`:

| Bucket | Per hour | Per day |
| --- | --- | --- |
| Origin (deployed app) | 4,000 | 40,000 |
| IP (no origin) | 1,000 | 5,000 |

**Weights.** Limits are denominated in weighted units, not raw calls. `eth_getLogs` counts as 100, `eth_getBlockByNumber` and `eth_getBlockByHash` count as 2, everything else counts as 1. See `methodRequestCounts` in `config.js`.

Enforcement itself is a fast in-memory set lookup on every request. The blocklists behind it are refreshed from Postgres every 10 seconds by a background poll. Limited callers get a 429 with JSON-RPC error `-32005` and a `Retry-After` header. The check fails open.

### 6. Forward upstream, with a circuit breaker

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
