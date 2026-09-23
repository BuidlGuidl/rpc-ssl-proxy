# eth_getLogs on Reth: Test Results and Design Implications

Tests run 2026-09-22 against one production reth node, direct (not through the proxy
or load balancer), from a separate machine on the same LAN. No host metrics were
available; everything was measured over RPC.

Purpose: inform the design of keyed (API key) `eth_getLogs` access with metering.
Anonymous callers stay blocked from getLogs.

---

## Overall summary

> **⚠️ Likely root cause of slow and failing getLogs in production:** the pool's
> Socket.IO server uses the default `maxHttpBufferSize` of **1 MB**. From reading the
> code (not tested yet), any node response over ~1 MB, e.g. ~10 blocks of USDC logs,
> **disconnects the node that served it**. The pool then waits out its 10 s timeout,
> retries a second node (which also disconnects), and bg-rpc-proxy finally serves the
> query from the paid fallback after 15 s. Nothing in the chain compresses anything.
> See "Message size and compression findings".

1. **Cost is driven by block range, not result count.** Reth scans every block in the
   range whether or not anything matches: ~0.05–0.1 ms per block. A zero-result query
   over 100k blocks took ~6.5–8 s and returned 36 bytes. The dangerous query is a
   **wide range with a selective filter**, not a query that returns lots of data.
2. **The 20,000-log cap (reth default) fails fast.** Oversized result sets error in
   50–200 ms, faster than successful queries. Successful responses max out around
   ~12.5 MB. Queries with no address hit this cap within ~15–40 blocks and are
   therefore cheap for the node.
3. **Aborting a request does not stop the node's work.** A client disconnect at 1 s
   left the node busy for as long as a query run to completion. Proxy timeouts protect
   the caller, not the node. **Range caps and concurrency caps are the real protection.**
4. **Throughput levels off at ~8 concurrent getLogs per node** (10k-block ranges):
   ~8 queries/s, ~80k blocks scanned per second in total. Up to 16 concurrent, cheap
   calls (`eth_call`, `eth_blockNumber`) were **unaffected** and the node stayed in sync.
5. **Batches run sequentially in reth.** A batch of 10 took as long as 10 sequential
   requests. Reth accepted a batch of 1,000 with no limit.
6. **Receipt history on this node starts at block 25,300,000 (L), fixed.** That's the
   snapshot the node synced from, ~735k blocks (~100 days) before the tests. Below L,
   getLogs returns `[]` **silently**, and receipts are `null`, while blocks and
   transactions are still served. Other reth nodes may have a different L, depending
   on their snapshot.
7. **Capacity is much higher than expected.** With a 10k-block cap, one reth node
   sustains ~8 max-range queries per second, about 28,800 per hour. That's roughly 55
   keys at a 50k-unit/hour budget, *if load is spread evenly*. Bursts, geth nodes in
   the pool, and uncapped query shapes all lower this.
8. **Reth itself held up under bounded getLogs, so the past outages were likely made
   worse by the proxy.** The proxy has no in-flight cap and no batch cap. It fully
   parses and re-serializes large responses on the event loop, and its circuit
   breaker and fallback retries feed back into each other. This is a hypothesis;
   incident logs are needed to confirm it (see "Open questions").
9. **The downstream chain multiplies slow getLogs.** Reading bg-rpc-proxy and
   bg-rpc-pool showed that timeouts don't line up across the layers (pool 10 s plus a
   second-node retry; bg-rpc-proxy 15 s plus a fallback; this proxy 15 s plus a
   fallback). One slow getLogs can run on 2 volunteer nodes and 2 paid fallback
   providers. bg-rpc-proxy also sends node errors like "exceeds max results" to the
   fallback, which bypasses the node caps. Together with the 1 MB message limit
   (point 10), this is the most likely reason production getLogs took over 15 s.
10. **The node-to-pool link can't carry responses over 1 MB, and nothing is
    compressed.** Fixing the 1 MB limit is required before the pool can serve getLogs
    at all. Even then, 16 MB responses under load would make the Node processes
    (memory, JSON parsing, volunteer upload) the bottleneck before reth. A lower log
    cap (~5,000 logs, ~3–3.5 MB) and compression on the Socket.IO link are
    recommended.

### Recommended settings (proposed)

| Setting | Value | Basis |
|---|---|---|
| Proxy block-range cap (keyed getLogs) | **10,000 blocks** | worst observed ~1.6 s cold |
| Reth `--rpc.max-blocks-per-filter` | **10,000** (backstop; default 100,000) | stops the 6–11 s scans of 100k blocks |
| Reth `--rpc.max-logs-per-response` | consider **~5,000** (default 20,000) | fails fast either way; 5,000 logs is ~3–3.5 MB instead of ~12.5–14 MB, which the chain handles far better (see "Message size and compression findings"). Applies to every getLogs on the node. |
| Lower block limit | reject `fromBlock < L` per node; find L by binary search on `eth_getBlockReceipts` (~19 calls) | reth returns silent `[]` below L |
| Global getLogs concurrency per reth node | **8** | throughput levels off at 8 |
| Per-key concurrency | **2** | |
| Metering unit | ~1 unit per 100 blocks in the range (10k blocks = 100 units, the current `eth_getLogs` weight), minimum ~5 | cost follows range; range is known before forwarding |
| Proxy response size cap | **~16 MB** at 20k logs, or **~5 MB** with a 5,000-log cap | largest observed 12.5 MB at the 20k-log cap |
| Pool Socket.IO `maxHttpBufferSize` | raise from the **1 MB default** to just above the largest allowed response | **required**: larger responses currently disconnect the node |
| Pool Socket.IO `perMessageDeflate` | **enable** | node clients already offer it; cuts volunteer upload time |
| getLogs per batch | **≤ ~5**, each charged separately; also cap total batch length for all callers | batches run sequentially; reth accepted 1,000 |
| Timeout | normal 15 s is fine once the range cap is in place | slowest 10k query ~1.6 s |
| Circuit breaker / fallback | getLogs **excluded** from breaker accounting; **no** fallback retry | avoid pushing everyone onto the fallback |
| Upstream routing | send keyed getLogs **only to reth nodes** | reth enforces the log and block caps; geth has no result cap and is untested |
| Requests over the cap | **reject at the edge proxy, don't split**; the error states the max range and suggests a `[fromBlock, toBlock]` that fits | see "Handling requests over the cap" |
| Pool: retry on timeout | **no second-node retry** for getLogs | the aborted query keeps running, so a retry doubles the work |
| Pool: 3-node comparison | **exclude getLogs** (add it to `methodsToSkipComparison`) | 1 in 20 getLogs currently runs on 3 nodes |
| Pool: getLogs timeout | **~5 s** (currently 10 s) | slowest 10k-block query ~1.6 s |
| Pool: routing | load-aware for **all** requests (power of two choices on weighted in-flight counts); getLogs additionally restricted to reth nodes whose L covers the range; at most ~4 getLogs per node | see "Pool routing design (proposed)" |
| bg-rpc-proxy: fallback | **never** send getLogs to the fallback; return node errors (e.g. "exceeds max results") to the caller | otherwise node caps are bypassed through the paid provider |
| bg-rpc-proxy: batches | cap batch length | items run one after another, with no limit |
| Timeouts across layers | make them agree: each layer's timeout longer than the layer below's total, retries included | currently each layer gives up while the one below is still retrying |
| Header forwarding | strip client headers at the edge | bg-rpc-proxy forwards headers to the fallback provider, so an API key would leak |

### Query duration by block range (quick reference)

Duration depends mostly on **how many blocks the range covers**, not on how many logs
come back. Times are cold / warm, measured against the node directly (network round
trip ~4–5 ms).

**Filters that match few or no logs (the slow case).** Time grows roughly linearly with
range, at about **0.5–1 s per 10k blocks**, even when nothing matches:

| Range | ENS (sparse) | EMPTY (zero results) |
|---|---|---|
| 1,000 blocks | 45–150 ms | 40–100 ms |
| 10,000 blocks | **0.5–1.6 s** | 0.5–0.85 s |
| 50,000 blocks | 2.4–6.8 s | 2.4–3.9 s |
| 100,000 blocks (reth default max) | **6.3–11.4 s** | 5.7–8.1 s |

**Busy contract (USDC): fast, then capped.**

| Range | Time | Logs |
|---|---|---|
| 10 blocks | ~35 ms | ~1–1.4k |
| 100 blocks | ~145–180 ms | ~11–14k |
| 150 blocks | ~190–230 ms | ~17–20k |
| 200+ blocks | **80–200 ms, error** | hits the 20k-log cap |

**No address (topic only, or no filter):** 20–115 ms for 1–10 blocks. These hit the
20k-log cap within ~15–50 blocks and error out in ~50 ms.

**Under concurrency** (10k-block queries): median ~0.8–1.0 s up to 8 at once, rising to
~2.0 s at 16 at once.

**In a batch:** reth runs items one after another, so 10 queries of ~0.6 s each took
~6.4 s as one request.

**Takeaway:** with a 10k-block cap, the worst case is ~1.6 s, well under the 15 s
timeout. Without a cap, one request can hold the node for ~10 s, and aborting it does
not stop that work.

---

## Test environment

- Node: reth **v2.5.0**, `--full`, launched by buidlguidl-client with
  `--prune.bodies.pre-merge --prune.receipts.before 15537394`.
  `reth.toml` prune config: receipts and bodies before the Merge (15,537,394);
  account/storage history `distance = 10064`.
- RPC limits at defaults:
  - `max-blocks-per-filter` 100,000
  - `max-logs-per-response` 20,000
  - `max-response-size` 160 MB
  - `max-connections` 500
  - `max-blocking-io-requests` 256
  - `rpc-cache.max-concurrent-db-requests` 512
  - `rpc-cache.max-receipts` 2,000
  - `max-tracing-requests` 14, which suggests ~16 cores
- HTTP API namespaces: `eth,net,admin`, on `0.0.0.0` with CORS `*`.
- Network round trip from the test machine: median 4–5 ms.
- HEAD at test time: ~26,034,960.
- Windows used:
  - **R (recent):** ranges ending at HEAD − 100
  - **O (old):** ranges ending at HEAD − 500,000
- Each query was run twice: cold, then warm.

---

## Detailed findings

### 1. Receipt limit (test 0)

- **L = 25,300,000.** HEAD − L = 734,960. The binary search took 19 calls, and all
  boundary checks passed (L − 1 null; L, L + 1 and L + 100 non-empty).
- L is well after the configured receipt prune point (the Merge). The gap comes from
  the **snapshot used for sync**: newer reth versions require a snapshot, so this is
  outside our control.
- **L is fixed; it does not move with the head.** Each node's L depends on when and
  from what snapshot it was bootstrapped, so it will differ between nodes.

### 2. Range scaling on a busy contract: USDC (test 1)

| window | range | cold ms | logs | bytes | result |
|---|---|---|---|---|---|
| R | 10 | 39 | 1,433 | 0.9 MB | ok |
| R | 100 | 179 | 14,160 | 9.0 MB | ok |
| R | 150 | 220 | 19,616 | 12.5 MB | ok |
| R | 200 | 89 | — | 132 B | exceeds 20k |
| R | 2,000 | 199 | — | 132 B | exceeds 20k |
| O | 150 | 232 | 16,857 | 10.7 MB | ok |
| O | 200 | 112 | — | 132 B | exceeds 20k |

- USDC averages ~100–140 logs per block, so it hits the 20k cap at ~150–200 blocks.
- Hitting the cap **costs less than a large successful query**, so reth stops early.
  The error suggests a smaller range to retry, e.g.
  `query exceeds max results 20000, retry with the range 26034661-26034819`.
- ~635 bytes per log, so a response at the cap is ~12.5 MB.
- Little cold/warm difference (ratio 1.03 in R, 1.19 in O).

### 3. Sparse and empty addresses (test 2)

| address | window | range | cold ms | warm ms | logs |
|---|---|---|---|---|---|
| ENS | R | 10,000 | 1,596 | 705 | 1,286 |
| ENS | R | 100,000 | 11,369 | 6,971 | 11,336 |
| ENS | O | 10,000 | 1,248 | 573 | 1,041 |
| ENS | O | 100,000 | 10,407 | 6,316 | 8,622 |
| EMPTY | R | 100,000 | 8,053 | 7,471 | 0 |
| EMPTY | O | 100,000 | 6,515 | 5,676 | 0 |

- Time grows linearly with range **even with zero results**. EMPTY costs ~790–980 ms
  per 10k blocks in window R and ~450–650 ms in window O. Recent blocks were somewhat
  slower per block than old ones; the reason is unknown.
- **This is the expensive pattern:** a small request and a small response, with
  seconds of node work in between.
- The block cap is off by one: a **100,001-block range was accepted**, so reth checks
  `to − from ≤ 100000`.

### 4. Queries with no address (test 3)

| variant | logs per block | fails at range | cold ms at failure |
|---|---|---|---|
| Transfer topic only | ~530–1,090 | 50 | 47–53 |
| No filter at all | ~860–1,650 | did not fail at 10 | — |

- These queries hit the 20k-log cap within tens of blocks and fail fast. Their node
  cost is **bounded by the log cap**. Their main cost is bandwidth: up to ~12 MB per
  response.
- **Separate range limits by filter type are unnecessary.** One range cap plus the
  node's log cap covers them.

### 5. Multiple addresses (test 4)

- `[USDC, ENS, EMPTY]` over 100 blocks: 143 ms, compared with 165 ms for USDC alone.
- 5 sparse addresses over 10k blocks: 1,230 ms and 2,912 logs, compared with 611 ms
  and 1,041 logs for ENS alone.
- Extra addresses cost roughly in proportion to the extra logs; there's no big added
  cost per address. A modest cap on addresses per filter (e.g. 10) is still sensible.

### 6. Edge cases (test 5)

| case | reth behavior |
|---|---|
| Range entirely below L (5b) | **`[]`, no error** |
| Range straddling L (5a, USDC) | hit the 20k-log cap first, so partial behavior is untested (the retry hint started below L) |
| `toBlock` above head (5c) | error: `block range extends beyond current head block` |
| `from > to` (5e) | error: `invalid block range params` |
| `earliest` → `latest` (5f) | error in 7 ms: `query exceeds max block range 100000`, rejected before scanning |
| `safe`/`safe`, `finalized`→`latest`, `pending`/`pending`, both omitted | work as expected |
| `fromBlock` omitted (= latest), `toBlock` in the past (5k) | error: `invalid block range params` |
| `blockHash` alone (5l) | works |
| `blockHash` + range (5m) | `Invalid params` |
| `blockHash` of a block below L (5n) | error: `block not found`, **even though the block itself exists** |
| Zero hash, malformed hex, decimal number, bad address | errors (`block not found` / `Invalid params`) |

5d (`fromBlock` HEAD + 10) returned data only because the chain advanced during the
run. That's not a bug.

**Takeaway:** reth already validates head, ordering, the max range, malformed input,
and `blockHash` combined with a range, with clear error messages the proxy can pass
through. The proxy mainly needs to add:
- **the range cap**
- **the lower block limit (L)**
- **resolving tags into a block count, for metering**
- **batch limits**

### 7. Receipts and transactions below L (test 9)

| method | old block (L − 5,000) | recent block (HEAD − 1,000) |
|---|---|---|
| `eth_getBlockByNumber` | block (413 txs) | block (334 txs) |
| `eth_getBlockReceipts` | **`null`** | 334 receipts |
| `eth_getTransactionReceipt` | **`null`** | receipt |
| `eth_getTransactionByHash` | transaction | transaction |

- **This affects anonymous traffic today, not just keyed getLogs.** A wallet or dapp
  asking for the receipt of a transaction older than ~100 days sees that the
  transaction exists but gets a `null` receipt. That usually reads as "pending / not
  mined." Whenever the load balancer routes such a request to reth, users see this.
- Not yet compared against geth or Nethermind.

### 8. Concurrency (test 6)

Query Q: ENS, 10k-block range, random ranges between HEAD − 700k and HEAD − 300k,
~1.2 s alone. N workers each looped Q for 60 s, while a separate loop sent
`eth_blockNumber` and an `eth_call` every 200 ms.

| N | getLogs/s | getLogs p50 | getLogs p95 | eth_call p95 | max lag |
|---|---|---|---|---|---|
| 0 | — | — | — | 11 ms | 13 s |
| 1 | 1.01 | 926 | 1,572 | 12 ms | 14 s |
| 2 | 2.42 | 772 | 1,268 | 10 ms | 14 s |
| 4 | 5.11 | 777 | 993 | 10 ms | 16 s |
| 8 | 7.38 | 1,056 | 1,419 | 13 ms | 14 s |
| 16 | 7.90 | 2,014 | 2,488 | 14 ms | 14 s |

- Throughput levels off between N = 8 and N = 16 (~8/s). At 16, latency doubles with
  no gain in throughput.
- **Cheap calls were unaffected at every level**, and the node stayed in sync. getLogs
  mostly competes with other getLogs.
- Not tested:
  - N > 16
  - 100k-block ranges under concurrency
  - overload, where more work is requested than the node can finish

### 9. Does aborting cancel the node's work? (test 7)

H: ENS, 100k-block range, ~10.4 s alone. 8 copies were sent at once. Probe P (USDC,
10 blocks) ran every 500 ms throughout.

| phase | P back to baseline (below the 7a p95 of 49 ms, 5 s in a row) |
|---|---|
| 7b: 8 copies run to completion (they finished at 9.5–12.7 s) | 11.5 s |
| 7c: 8 copies aborted at 1 s | 12.0 s |

- Recovery took the same time whether the queries were aborted or not, so **reth kept
  working after the client disconnected.**
- The signal is small (probe median +10–15 ms while loaded), but the timing matched
  T_H in both phases. Confidence: moderate to high.
- **Implications:**
  - A proxy timeout doesn't free node capacity.
  - A caller can send heavy queries and disconnect right away, costing themselves
    nothing while the node does the full work.
  - Concurrency limits must be counted in node work, which the range cap makes
    predictable.

### 10. Batches (test 8)

| mode (10 × Q) | total ms |
|---|---|
| one batch | 6,430 |
| sequential | 6,408 |
| concurrent | 1,076 |

- **Reth runs the items in a batch one after another.** A batch doesn't add
  concurrency, but it multiplies duration. With no cancellation, one HTTP request
  holding many heavy getLogs is a large amount of node work.
- Batches of 10, 100 and 1,000 `eth_blockNumber` calls were all accepted; there is no
  batch limit on the node side.

### 11. Namespaces and exposure (test 10)

- `admin_nodeInfo` **succeeds** over HTTP; the admin namespace is exposed.
  (`--http.addr 0.0.0.0`, `--http.corsdomain *`.) The proxy blocks `admin_*`, but
  anything that can reach port 8545 directly can call it.
- `trace_block`: `Method not found`, so trace isn't enabled on reth.
- `rpc_modules`: `Method not found`, since the `rpc` namespace isn't enabled.
- **Not tested: whether the node can be reached from the internet** (test 10a). If
  it can, all proxy-side protections can be bypassed.

---

## Proxy-side weaknesses (hypothesis for past outages)

Reth handled bounded getLogs well, so these proxy behaviors likely made past
incidents worse. References are to `proxy.js` as of commit `f73eef6`.

1. **Full buffering and re-serialization.** Axios parses the whole upstream response,
   then `res.send` serializes it again. For ~12 MB getLogs responses, that's
   synchronous JSON work that blocks Node's event loop and slows *every* request.
2. **The fallback path logs full response bodies**
   (`console.log("POST FALLBACK SUCCESS", response.data)`, ~line 280).
3. **An amplification loop:**
   - slow responses → primary timeouts
   - 2 failures open the circuit breaker, and **all** traffic goes to the fallback
     for 60 s
   - every failure is retried on the fallback (~line 279)
   - each fallback request creates a new `https.Agent` (a full TLS handshake every
     time, ~line 114)
   - the fallback provider may rate-limit, producing more failures
4. **No limit on in-flight requests and no batch length cap.**
5. **Geth in the pool has no log result cap.** A wide getLogs routed there could
   return hundreds of MB. Untested.

---

## Load balancer (bg-rpc-pool) findings

From reading https://github.com/BuidlGuidl/bg-rpc-pool (`config.js`, `pool.js`,
`utils/handleRequestSingle.js`, `utils/handleRequestSet.js`,
`utils/selectRandomClients.js`). The chain as described in its README:
clients → proxy → pool (`POST /requestPool`) → volunteer nodes over Socket.IO.

1. **The pool likely explains production getLogs taking over 15 s.** `config.js` sets
   `eth_getLogs` to a **10 s** timeout per node (default is 3 s), and
   `handleRequestSingle` **retries a second node after a timeout**. A slow getLogs can
   take **~20 s** in the pool, beyond this proxy's 15 s timeout. Test 7 showed reth
   doesn't stop work when the caller disconnects, so the first node keeps working
   while the second starts: **one slow query becomes two.**
2. **1 in 20 getLogs goes to three nodes at once.** getLogs isn't in
   `methodsToSkipComparison`, so with `requestSetChance = 20`, 5% of getLogs run on 3
   nodes in parallel for result comparison: triple the work for the most expensive
   method.
3. **The nodes are volunteer machines, and responses travel over their upload
   links.** Nodes (buidlguidl-client) connect out to the pool over Socket.IO, and
   results come back through that session. The ~12.5 MB responses measured on the LAN
   cross each volunteer's home upload link in production, likely adding seconds per
   large response. This makes the response size cap and the node's 20k-log cap more
   important.
4. **The pool knows each node's client, but routing ignores it.** buidlguidl-client
   sends `execution_client` (e.g. `"reth v2.5.0"`) at check-in
   (`webSocketConnection.js` ~line 245). The pool stores it in `poolMap`, and the
   dashboard shows it. `selectRandomClients` doesn't use it. **Routing keyed getLogs to
   reth only is just a filter on existing data**, with no client change needed.
   (Corrected: an earlier version of this document said check-in lacked the client
   type.)

   Pool snapshot, 2026-09-23 (Active Nodes page, 16 nodes):
   - **13 reth**, versions **v1.9.3 to v2.5.0**
   - **2 geth** (v1.16.7, v1.17.4)
   - **1 Nethermind** (v8.1.2)

   Only reth 2.5.0 was tested. Defaults for the log and block caps may differ in older
   versions, so set those flags explicitly in buidlguidl-client rather than relying
   on version defaults.

   Some nodes were unhealthy at the time of the snapshot: one reth 1.11.3 node at 98%
   CPU and ~27k blocks behind; the Nethermind node at 99.7% CPU and ~12k behind; one
   node at 98% storage. The head-block filter already keeps the lagging ones out of
   routing. Two nodes showed Socket ID `N/A`, which may be normal reconnecting or the
   1 MB disconnect; unverified.
5. **The pool doesn't know each node's receipt limit (L).** It picks nodes by head
   block and past timeout rate only. Each volunteer node has its own L, set by the
   snapshot it synced from. Options:
   - nodes report L at check-in, and the pool only sends a getLogs to nodes whose L is
     at or below its `fromBlock`; or
   - keyed getLogs only allows a recent window that every node is sure to have.
6. **Exposure is lower than feared.** Pool nodes never receive internet traffic
   through the pool; they only get work over their own outbound Socket.IO session. Test
   10a matters only for operators who port-forward 8545 themselves.
7. **`/requestPool` handles one request at a time.** It treats the body as a single
   JSON-RPC object; batches are split one layer up, in bg-rpc-proxy (see next
   section).

---

## bg-rpc-proxy findings (layer between this proxy and the pool)

From reading https://github.com/austintgriffith/geth-node-ssl-proxy/tree/bg-rpc-proxy
(`proxy.js`, `config.js`, `utils/handleRequest.js`, `utils/validateRpcRequest.js`;
its README is outdated and was ignored). Assumes this repo's `TARGET_URL` points to
bg-rpc-proxy, making the chain:
**this proxy → bg-rpc-proxy → bg-rpc-pool → volunteer nodes.**

1. **Batches are split here, and the items run one after another.** `app.post("/")`
   loops over the batch and `await`s each `processSingleRequest` in turn. A batch of N
   getLogs takes the **sum** of N full pool round trips, each of which can include the
   node timeout, a retry and a fallback. There's no cap on batch length at this layer.
2. **One slow getLogs can run up to four times.** Following a single slow getLogs
   through the chain:
   - **Pool:** node 1 times out at **10 s**, so the pool retries **node 2**. Node 1
     keeps working (test 7).
   - **bg-rpc-proxy:** gives up on the pool at **15 s** (`poolRequestTimeout`) and
     retries on **its own `FALLBACK_URL`**, with a 10 s timeout
     (`fallbackRequestTimeout`). Node 2 is still working.
   - **This proxy:** also times out at **15 s**, while bg-rpc-proxy's fallback attempt
     is still in flight. It then retries on **its own fallback** (`proxy.js` ~line
     279) and counts a circuit breaker failure. Two of these open the breaker **for
     all users**.

   Result: one slow query can run on **2 volunteer nodes and 2 paid fallback
   providers**, and the user still sees a timeout or a slow result. **This is the
   best explanation so far for production getLogs taking over 15 s.**
3. **Reth's getLogs caps are bypassed by the fallback.** In bg-rpc-proxy, **any** pool
   error whose code isn't in `ignoredErrorCodes` goes to the fallback provider. When
   reth correctly rejects a query with "query exceeds max results 20000", bg-rpc-proxy
   sends the same query to the paid fallback. Unless reth's error code is in
   `ignoredErrorCodes` (a shared file, not in the repo, not checked), node-side caps
   don't protect anything: the query goes to the paid provider, which may serve it.
4. **Every failure sends a Telegram alert** with the full request and response JSON.
   During a getLogs flood, that's an alert per failed request.
5. **Large responses are parsed and serialized over and over.** A ~12.5 MB result is
   parsed and re-serialized in **three Node processes**: the pool (Socket.IO),
   bg-rpc-proxy (axios, then `res.json`), and this proxy (axios, then `res.send`).
   Each step blocks that process's event loop. bg-rpc-proxy also creates a new
   `https.Agent` and **reads the cert and key from disk synchronously on every
   request**.
6. **Headers are forwarded all the way to the fallback.** bg-rpc-proxy forwards every
   client header except `host` to both the pool and `FALLBACK_URL`. Since this proxy
   also forwards everything, an `X-Api-Key` header would reach a third-party provider.
   **Stripping client headers at the edge is a requirement for the key design.**

### What this means for the design

- **Edge proxy (this repo):** reject over-cap and batch-limited requests *before* they
  enter the chain. Everything downstream turns one expensive request into several.
  Strip client headers before forwarding.
- **bg-rpc-proxy:**
  - never send getLogs to the fallback
  - pass node errors like "exceeds max results" straight back to the caller instead
    of retrying
  - cap batch length
- **All three layers:** agree on timeouts. Currently each layer's timeout fires while
  the layer below is still retrying (pool 10 s + retry; bg-rpc-proxy 15 s + 10 s
  fallback; this proxy 15 s + fallback).

---

## Message size and compression findings

Checked against the code in all three repos plus buidlguidl-client
(`webSocketConnection.js`), and the source of the libraries themselves
(`engine.io` 6.6.x, `engine.io-client` 6.6.x, `ws` 8.x). **Not tested against the
deployed system.**

### Compression at each hop: none

| Hop | Compressed? | Why |
|---|---|---|
| Client ↔ this proxy | No | no compression middleware in Express |
| This proxy → bg-rpc-proxy | No | no compression middleware in bg-rpc-proxy |
| bg-rpc-proxy → pool (`/requestPool`) | No | the pool writes the response with a plain `res.end(JSON.stringify(...))` |
| **Pool ↔ volunteer nodes (Socket.IO)** | **No** | the node's client offers compression (engine.io-client defaults to `perMessageDeflate: {threshold: 1024}`), but the pool's server leaves `perMessageDeflate` at its default (off), so the connection runs uncompressed |
| Node → its own reth | No | localhost, doesn't matter |

### The 1 MB message limit on the node-to-pool link

- The pool creates its Socket.IO server (`pool.js` ~line 170) with only `cors`,
  `pingInterval` and `pingTimeout`. `maxHttpBufferSize` isn't set anywhere, so the
  engine.io default applies: **1 MB** (`maxHttpBufferSize: 1e6`).
- For WebSocket connections, engine.io passes that value to `ws` as `maxPayload`.
  A larger incoming message fails with **"Max payload size exceeded" (close code
  1009)**, and the connection is closed.
- A node's RPC result returns as a Socket.IO acknowledgement, a message from the
  node to the pool. So **any response over ~1 MB disconnects the node that served
  it.**
- From the test data, 1 MB is roughly:
  - ~10 blocks of USDC logs (910 KB)
  - ~1 block of unfiltered logs (660 KB–1.1 MB)
  - probably some `eth_getBlockReceipts` and full `eth_getBlockByNumber` calls on
    busy blocks (not measured)

**What a getLogs over 1 MB then does (from reading the code):**
1. Node 1 runs the query, sends the result, and gets disconnected. Every other
   request in flight on that node is lost too.
2. The pool hears nothing back, waits the full **10 s** timeout, then retries
   **node 2**, which gets disconnected the same way.
3. bg-rpc-proxy gives up at 15 s and sends the query to the **paid fallback**, which
   serves it.
4. Both nodes reconnect after about 10 s (`reconnectionDelay: 10000`). The timeouts
   count against their weekly timeout rate, which can get healthy nodes classified
   as "slow" and removed from routing.

This fits the production symptoms: getLogs of any real size takes 15+ s, succeeds
eventually through the fallback, and hurts the pool along the way.

**Caveat:** the deployed pool may differ from GitHub. To confirm, look for:
- `timeout_error` entries for `eth_getLogs` in the pool logs, on nodes that
  reconnect shortly afterwards
- a "disconnect" message in a buidlguidl-client debug log right after a large getLogs

### Cost of large responses under load

Even with the 1 MB limit raised, at each hop a 16 MB response gets:
- **Transferred:** over a volunteer's home upload, ~13 s at 10 Mbps with no
  compression. Usually the slowest step.
- **Held in memory several times:** raw text plus parsed JavaScript objects (several
  times the JSON size), roughly **50–100 MB of temporary memory per response per
  process**, in this proxy, bg-rpc-proxy and the pool alike.
- **Parsed and serialized synchronously:** each parse or serialize of 16 MB blocks
  that process's event loop for somewhere between ~100 and a few hundred ms, several
  times per hop.

At the node's measured throughput (~8 max-size queries per second), those JSON steps
alone would take more than one CPU core's worth of time in each single-threaded Node
process. **The Node processes would become the bottleneck before reth does,**
consistent with reth having plenty of headroom in the tests.

### Recommendations

1. **Required before getLogs can go through the pool at all:** set
   `maxHttpBufferSize` on the pool's Socket.IO server just above the largest
   allowed response. Also check how the current 1 MB limit affects
   `eth_getBlockReceipts` and full blocks today.
2. **Lower the response size rather than planning for 16 MB.** For example,
   reth `--rpc.max-logs-per-response 5000` brings the typical worst case to
   ~3–3.5 MB: 4× less memory, parsing and upload time per response. Clients split
   on the error anyway. This applies to every getLogs on those nodes; the edge
   proxy could enforce its own lower limit instead.
3. **Enable `perMessageDeflate` on the pool's Socket.IO server.** Node clients
   already offer it. Hex-heavy JSON should compress several times over, which cuts
   volunteer upload time directly. zlib runs on Node's thread pool, so it adds little
   event-loop blocking. The size limit applies to the uncompressed size, so this
   doesn't replace item 1. Measure the ratio first by gzipping a saved response.
4. **Compression at the edge (client ↔ this proxy)** is optional. It helps clients
   on slow connections but doesn't relieve the internal chain.

---

## Handling requests over the cap: reject, don't split

**Recommendation:** reject requests over the 10k-block cap at the edge proxy (where
keys and metering live), before anything reaches the pool.

- **Splitting defeats the cap.** The cap bounds the work one request can cause. If the
  server splits a 100k-block request into ten 10k chunks, the node still does all
  ~10 s of work, with no cancellation, and the combined response can reach
  ~10 × 12.5 MB.
- **Split results fail badly in the pool.** Chunks would go to different random
  nodes, with different L and at slightly different heads. A chunk landing on a node
  that has pruned that range returns `[]` silently, so the combined result is
  **silently missing logs**. Partial failures (a chunk times out, or hits the 20k-log
  cap) are also messy.
- **Clients already handle rejection.** Indexers and log-scanning libraries expect
  range errors and split on their own. Providers like Alchemy reject with a message
  suggesting a working range, and some libraries parse it and retry automatically.
  **Copy that convention:** state the max range and a suggested `[fromBlock, toBlock]`
  in the error (like reth's `retry with the range X-Y`). Check which formats viem,
  ethers and ponder actually parse before settling on wording.
- **Metering stays simple:** one request, one range, one charge.

### Where each limit belongs

- **Edge proxy (this repo):** keys, metering, the 10k-block cap (reject, with a
  suggested range), the lower block limit, batch limits, the response size cap.
- **Pool (bg-rpc-pool):**
  - no second-node retry for getLogs
  - no 3-node comparison for getLogs
  - a getLogs timeout matched to the cap (~5 s)
  - route to reth nodes whose L covers the request
- **Nodes (buidlguidl-client):** `--rpc.max-blocks-per-filter 10000` as the last line
  of defense.

---

## Pool routing design (proposed)

Goal: load-aware routing for **all** request types, with heavy requests (getLogs)
further limited to nodes that meet extra requirements (reth, receipt limit covers the
range), **without turning the pool's selection code into a pile of special cases.**

### Why load-aware routing

- **Per-node capacity is limited:** reth getLogs throughput levels off at ~8
  concurrent (test 6). Random routing can send several heavy queries to one node
  while others sit idle.
- **Nodes differ a lot:** volunteer hardware, reth versions from v1.9.3 to v2.5.0,
  some already under high CPU load.
- **Overloaded nodes set off the retry chain** (pool timeout → second node →
  fallback). Avoiding busy nodes prevents timeouts before they start, and it keeps
  healthy nodes' timeout rates from climbing until they're marked "slow."
- It matters mostly for heavy methods. For cheap calls that finish in milliseconds,
  random routing is already fine.

### Structure: one table, one pipeline

**1. One table of method profiles, the single source of truth.** It replaces
`nodeMethodSpecificTimeouts`, `methodsToSkipComparison` and `cacheableMethods` in
`config.js`. Anything not listed gets the default "light" profile.

```
PROFILES = {
  default:        { class: "light", cost: 1,   timeout: 3s,  retry: true,  compare: true,  fallback: true },
  eth_getLogs:    { class: "heavy", cost: byRange,     timeout: 5s,  retry: false, compare: false, fallback: false,
                    requires: [clientIs("reth"), coversRange] },
  eth_getBlockReceipts: { class: "light", cost: 2, timeout: 2s, ... },
  eth_blockNumber:{ ..., compare: false },  // replaces methodsToSkipComparison
}
```

**2. One selection pipeline, the same for every request.** Hard requirements filter
the nodes; preferences only score them.

```
select(request, nodes, load, exclude = []):
  p = profileFor(request)
  candidates = nodes
    .filter(isConnected)          // checked in, not suspicious, socket live
    .filter(n => !exclude.has(n)) // nodes already tried for this request
    .filter(meetsAll(p.requires, request))  // e.g. reth, L ≤ fromBlock; empty for light requests
    .filter(isFreshEnough(request))         // head-block rule, applied AFTER the requirement filters
    .filter(hasCapacity(p.class, load))     // e.g. at most 4 heavy requests per node
  if candidates is empty → return NO_NODE(p)   // caller acts on the profile: busy error, or fallback
  return powerOfTwo(candidates, score)         // score = weighted in-flight count, then fast/slow as a tiebreaker
```

- **Power of two choices:** pick two random eligible nodes and send to the less busy
  one. Nearly as good as always picking the least busy node, without its failure
  mode: a node that fails instantly always looks idle and would attract all the
  traffic.
- **In-flight load is weighted:** getLogs counts by its block range, not as 1.
- **Per-node cap for heavy requests** (e.g. 4 concurrent getLogs, from test 6). If
  every eligible node is at its cap, reject quickly with "busy, retry." Don't queue,
  and don't fall through to the fallback.
- The client type is already available (`execution_client`, reported at check-in).
  L still has to be added to check-in.

**3. Dispatch follows the profile, and each retry selects again.**

```
dispatch(request):
  tried = []
  loop up to (p.retry ? 2 : 1) times:
    node = select(request, nodes, load, exclude = tried)
    load.add(node, p.class, p.cost)       // released on response or disconnect, NOT on timeout
    result = send(node, request, p.timeout)
    if ok or the error isn't retryable → return result
    tried.push(node)
  return failure    // bg-rpc-proxy then decides on the fallback, based on p.fallback
```

Load balancing then applies to every request automatically, and getLogs only adds
entries to `requires`. There's no separate code path for reth.

### Traps to avoid

1. **Filter order can empty the candidate set.** Today the target block is the
   highest block among fast nodes of *any* client type, and only nodes exactly at
   that block are kept. With a reth-only filter applied *after* that, if the only
   nodes at the new block are geth, getLogs has no candidates. Apply the hard
   requirements first, then the freshness rule computed within the remaining nodes
   (or with a ~1-block tolerance).
2. **Treating preferences as requirements.** Today fast/slow is a hard filter, and
   slow nodes are randomly added back as "spot checks." Make fast/slow part of the
   **score**. Run spot checks as their own explicit mechanism, and only for light
   requests.
3. **Selecting nodes up front and reusing them.** Today three nodes are chosen at the
   start, and the retry reuses the second one, which by then may be overloaded.
   Select again for each attempt, excluding nodes already tried.
4. **Counting load wrong:**
   - Releasing a request's count at the pool's timeout. The node is still working
     (test 7), so the pool thinks it's free and sends more. Release it when the late
     response arrives (the pool already receives late responses; it just ignores
     them), or when the node disconnects.
   - Keying load by socket ID. That ID changes on reconnect, which resets the count.
     Key it by node ID.
5. **Handling "no nodes" the same way for every method.** Light requests can fall
   back. For heavy requests, "all reth nodes at capacity" must return a **busy**
   error, not go to the paid fallback. The profile decides this, not a shared
   `catch`.
6. **Policy spread across three repos.** Each layer has one job:
   - **Edge proxy:** who may ask, and how much. Keys, range cap, batch limits,
     metering.
   - **bg-rpc-proxy:** forwarding and caching. No fallback for profiles that forbid
     it.
   - **Pool:** which node serves the request. Profiles, placement, load.

### Keeping it testable and observable

- Write `select()` as a function with no side effects: it takes a snapshot of the
  nodes, the load counts and the request, and returns a node or a reason. The
  pipeline can then be unit-tested with fake data, such as "all reth nodes at
  capacity," "only geth at head," or "a node that fails instantly."
- Log **one summary line per decision**, with the candidate count after each filter,
  e.g. `getLogs: 16 → 13 reth → 11 covers range → 10 at head → 7 with capacity →
  picked X`. Today `selectRandomClients` logs a line per node per request, which is
  noisy and still doesn't say why a node was chosen.
- Signals: in-flight counts are real-time and are the primary signal. The CPU%
  reported at check-in is stale between check-ins, but it could still be used to
  exclude nodes pinned at high CPU. A later refinement could factor in each node's
  average recent response time.

### Build order

Each step can be released and checked on its own:
1. Fix the 1 MB limit, and stop the retry and fallback for getLogs. These fix what's
   broken today.
2. Introduce the profile table and the pipeline, **keeping today's behavior**: no
   requirements, random scoring. A refactor you can check against current behavior.
3. Turn on load-aware scoring (power of two choices) for all requests.
4. Add `requires` for getLogs: reth only, then L coverage once nodes report it.

---

## Open questions and follow-ups

- [ ] **Incident logs:**
  - Did `CIRCUIT_OPEN` Telegram alerts fire during the getLogs spam?
  - Did the proxy process crash or run out of memory, or did the nodes fall out of
    sync?
  - Which clients served the heavy queries?
- [ ] **Test 10a:** can each pool node's port 8545 or 8546 be reached from the
  internet? Lower priority now: pool traffic reaches nodes only over their outbound
  Socket.IO session, so this only matters for operators who port-forward.
- [x] **Batch path:** answered. bg-rpc-proxy splits batches and runs the items one
  after another (see "bg-rpc-proxy findings").
- [ ] **`ignoredErrorCodes`:** check whether reth's "exceeds max results" and "max
  block range" error codes are in the shared `ignoredErrorCodes` file. If not,
  bg-rpc-proxy sends those queries to the paid fallback.
- [ ] **`TARGET_URL`:** confirm that it points to bg-rpc-proxy.
- [ ] **Confirm the 1 MB limit in production:**
  - check the deployed pool's Socket.IO options
  - look in the pool logs for `eth_getLogs` `timeout_error` entries followed by
    node reconnects
  - look for a disconnect in a buidlguidl-client debug log after a large response
- [ ] **Other methods over 1 MB:** measure `eth_getBlockReceipts` and full
  `eth_getBlockByNumber` sizes on busy blocks. If they exceed 1 MB, they're affected
  today too.
- [ ] **Compression ratio:** gzip one saved large getLogs response to measure what
  `perMessageDeflate` would save.
- [ ] **Log cap:** decide between keeping 20,000 logs per response or dropping to
  ~5,000.
- [ ] **Receipt limit (L) at check-in:** add L to buidlguidl-client's pool check-in.
  Client type is already reported (`execution_client`). With both, the pool can route
  keyed getLogs to reth nodes whose L covers the range.
- [ ] **Older reth versions:** check the defaults for `--rpc.max-logs-per-response`
  and `--rpc.max-blocks-per-filter` on v1.9–v2.3, or set them explicitly in
  buidlguidl-client.
- [ ] **Error message format:** confirm which "range too large" message formats viem,
  ethers and ponder parse for automatic splitting.
- [ ] **Receipt `null` bug:** compare `eth_getTransactionReceipt` for transactions
  older than L on geth and Nethermind. Decide whether to route old-receipt requests
  away from reth.
- [ ] **L on the other reth nodes:** each may differ; the proxy needs L per node, or
  a single conservative value.
- [ ] **Straddling range (5a):** rerun with a sparse address to confirm that partial
  results come back silently.
- [ ] **Load balancer:** answered. `TARGET_URL` leads to bg-rpc-pool, and nodes can't
  be reached directly, so reth-only routing has to happen in the pool (see "Load
  balancer (bg-rpc-pool) findings").
- [ ] **buidlguidl-client change:** set `--rpc.max-blocks-per-filter` for all client
  users, or only for pool nodes?
- [ ] **Key store:** Postgres was recommended, for keys and metering together.
  rpc-token-manager, mentioned in the retracted PR, is unaccounted for.
- [ ] **Key issuance:** who can get a key, and what it costs them. This is the real
  security boundary.
