# rpc-ssl-proxy

This is the **edge proxy**: the public entry point for rpc.buidlguidl.com. It forwards
JSON-RPC to the downstream proxy (`TARGET_URL`, bg-rpc-proxy on port 48544), which
forwards to the community node pool.

## Working docs live elsewhere

Cross-repo design work for this stack is tracked in the `bg-rpc-docs` repo
(github.com/BuidlGuidl/bg-rpc-docs), cloned at `~/bg-rpc-docs` on this machine. Read
its README for editing rules.

Before touching anything related to `eth_getLogs`, API keys, rate limiting of heavy
methods, or upstream timeouts/fallback, read:

- `~/bg-rpc-docs/IMPLEMENTATION_PLAN_GETLOGS_KEYS.md` — the plan; this repo owns
  Phases 1d, 1e (edge hop), 4 and 5 (edge side).
- `~/bg-rpc-docs/GETLOGS_RETH_TEST_RESULTS.md` — the measurements and findings the
  plan is based on.

When you finish or change a phase, update the plan's status board and commit that
change in `bg-rpc-docs` on its own. Don't copy those files into this repo.
