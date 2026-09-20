# API keys and eth_getLogs

`eth_getLogs` is blocked for anonymous traffic. The IP/origin rate limiter cannot
stop a caller who rotates IPs or invents origins, and heavy calls that time out
were never even counted. See "Encountered RPC User Security Concerns" in the
private `bg-rpc-overview` doc for the incident.

A request that carries a valid API key takes a different path:

| | anonymous | with key |
|---|---|---|
| identity | IP or `Origin` header (free to fake) | key (revocable, tied to a wallet) |
| `eth_getLogs` | refused (429, `-32005`) | allowed within bounds |
| budget | IP/origin hourly + daily, counted after success | per-key rolling hour, **charged before forwarding** |
| concurrent `eth_getLogs` | n/a | `getLogsMaxInFlightPerKey` (2) |
| block range per `eth_getLogs` | n/a | `getLogsMaxBlockRange` (2000) |

## Using a key

Put the key in the URL or a header. Both are equivalent.

```
POST https://mainnet.rpc.buidlguidl.com/v1/<key>
POST https://mainnet.rpc.buidlguidl.com/        with header  X-Api-Key: <key>
```

Keys are 16+ hex characters. A malformed, unknown or revoked key gets `401`
with a JSON-RPC error `-32001 Invalid API key`. It is not treated as anonymous.

## Where keys come from

`rpc-token-manager` (sign in with a wallet, mint keys) writes to the Firestore
collection `rpcKeys<FIREBASE_COLLECTION>`; doc id = key, fields `keyValue`,
`ethereumAddress`, `createdAt`. Deleting the doc revokes the key. A doc with
`revoked: true` is also treated as revoked.

The proxy mirrors that collection into memory every `apiKeyRefreshInterval`
seconds (60). The request path never reads Firestore. If the mirror has never
loaded, every key is rejected and the log says so.

Env: `FIREBASE_COLLECTION` (already used for the request ledger) and the
Firebase credentials already in `.env.example`.

## eth_getLogs bounds (keyed)

- `fromBlock`..`toBlock` may span at most `getLogsMaxBlockRange` blocks.
  `earliest` is block 0. `latest`/`pending`/`safe`/`finalized` resolve against
  a chain head the proxy refreshes every 12 s with an `eth_blockNumber` call.
  If no head is known yet, a tag is refused with a message asking for explicit
  hex block numbers. `blockHash` filters are always one block.
- A refused range returns HTTP 200 with JSON-RPC error `-32602` and a message
  saying the limit.
- At most `getLogsMaxInFlightPerKey` `eth_getLogs` per key at once. Over that
  is `429` with `Retry-After: 1`.

## Per-key budget

Every request costs `methodRequestCounts[method]` units (default 1,
`eth_getLogs` 100). The rolling-hour budget is `apiKeyRateLimitPerHour` (50000):
500 `eth_getLogs`, or 50000 light calls, or a mix. Same rolling-window
approximation as the IP/origin limiter. Over budget is `429` with the usual
rate limit body. The budget lives in proxy memory, so a restart clears it.

## Knobs

All in `config.js`: `apiKeyRefreshInterval`, `apiKeyRateLimitPerHour`,
`getLogsMaxBlockRange`, `getLogsMaxInFlightPerKey`, `apiKeySignupUrl` (shown
in the anonymous refusal message).

## Monitoring

`GET /status` now includes `apiKeys` (mirror health, key count),
`keyLimits` (top keys by usage, masked) and `latestBlock`.

## Tests

```
yarn test        # node --test test/*.test.js
```

Unit tests cover key resolution, the per-key limiter, and the range guard.
The Express wiring in `proxy.js` is not under test (it binds 443 on import).
