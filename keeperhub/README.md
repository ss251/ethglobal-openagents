# keeperhub/ — Pulse operator infrastructure as KeeperHub workflows

KeeperHub is a programmable execution layer for cron / event / on-demand
on-chain workloads. This directory holds Pulse's keeper logic in two
shapes that share the same source of truth:

- **`workflows/*.json`** — declarative workflow definitions that KeeperHub's
  keeper network executes on its own infrastructure. No box, no nohup, no
  pager rotation on the protocol team.
- **`scripts/keeperhub-*.ts`** (in [`../scripts/`](../scripts/)) — the same
  logic as a local one-shot you can run with any funded EOA. Permissionless
  by design, so the protocol always has an off-network fallback.

The local script is the canonical implementation. The workflow JSON is the
declarative restatement that KeeperHub picks up.

## What ports cleanly to KeeperHub

### `pulse-mark-expired` (cron `*/5 * * * *`)

| File | Purpose |
| --- | --- |
| [`workflows/pulse-mark-expired.json`](workflows/pulse-mark-expired.json) | KeeperHub workflow: cron 5-min sweep |
| [`../scripts/keeperhub-mark-expired.ts`](../scripts/keeperhub-mark-expired.ts) | Local sweep, dry-run + execute, BigInt-safe JSON |
| [`../packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md`](../packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md) | Agent-facing skill for both modes |

What it does:

1. Scans Pulse for `Committed(...)` events past the last-scanned block.
2. Filters by `block.timestamp >= executeAfter + revealWindow`.
3. For each id, calls `Pulse.markExpired(uint256)` with `gasLimit=500_000`.

Each successful call slashes the agent's ERC-8004 reputation by **−500**
("expired"). Pulse intentionally made this entrypoint permissionless —
*anyone* can clean up stuck Pending commitments, and the slash always
goes to the agent in the commitment, never to the caller.

The local script's value isn't the per-id RPC call (a workflow handles
that fine in `contract-call` mode) — it's the **iteration** over all
candidate ids and the dead-state filter (`commitTime > 0n` to skip
zero-struct cids past the high-water mark). The workflow restates the
same iteration as a `loop` step.

### Verified live

End-to-end on Eth Sepolia 2026-04-29:

```
8 commitments swept and expired:
  cid #6, #7, #8, #11, #17, #21, #25, #26
  → all status=Expired (3), -500 ERC-8004 rep slash each
```

Sweep time ≈ 30s for 8 commitments (each tx waits its receipt). Workflow
deployment frequency: cron 5-min — at most ~5 min lag between deadline
and on-chain expire.

## What does NOT port cleanly (and why)

`watch-and-slash.ts` (the atomic-reveal rollback recovery) — this watcher
needs to:

1. Listen for failed swap transactions targeting our v4 hook.
2. Decode the failed swap's `hookData` (`commitmentId + nonce`).
3. Decode the actual swap `key + params` from calldata.
4. Re-encode `(key, params)` and call `Pulse.reveal(commitmentId, nonce,
   abi.encode(key, params))` directly to lock in `Violated`.

A KeeperHub workflow's declarative steps (`http`, `filter`, `contract-call`,
`loop`) cannot express the calldata decoding + re-encoding step. It needs
a custom JS step / Lambda action — outside the scope of a clean port. We
keep `watch-and-slash.ts` as a long-running local service for now and
document the boundary honestly here.

If KeeperHub adds a generic "JS step" action, this becomes a one-file PR.

## Operator infrastructure: required → required-on-paper-only

Before this directory existed, **Pulse needed an off-chain expirer
daemon**. A box, somewhere, running `markExpired` on a schedule. That's
exactly the infrastructure tax KeeperHub eliminates.

After deploying `pulse-mark-expired.json` to KeeperHub:

- The keeper network handles cron scheduling.
- The keeper network handles gas (or the protocol funds a keeper-paid
  wallet — TBD per deployment).
- Failure mode: keeper network is down → run the local script, same logic.
- Audit trail: every `markExpired` tx is on-chain, indexed by the keeper
  network's run history *and* the chain's tx history. Two independent
  audit surfaces.

Pulse's operator burden for the expirer drops from "always-on box" to
"none."

## How to deploy a workflow

```bash
# 1. Inspect the JSON; replace COMMITTED_TOPIC_HASH at deploy time with
#    keccak256('Committed(uint256,uint256,bytes32,bytes32,uint64,uint64,address)')
#    from deployments/sepolia.json
cat keeperhub/workflows/pulse-mark-expired.json

# 2. Authenticate to KeeperHub (one-time)
kh login

# 3. Deploy
kh workflow deploy keeperhub/workflows/pulse-mark-expired.json

# 4. Status / pause / unpause
kh workflow status pulse-mark-expired
kh workflow pause   pulse-mark-expired
kh workflow resume  pulse-mark-expired
```

The JSON references three secrets your KeeperHub workspace must have set:
`SEPOLIA_RPC_URL`, `PULSE_ADDRESS`, `KEEPER_WALLET_ID`. The wallet must be
funded with enough Sepolia ETH to cover bursty markExpired calls
(`5e5 gas × ~5 expires/day × ~5 gwei` is rounding error in practice).

## Local sweep, no KeeperHub account required

Same logic, runnable today against the deployed Eth Sepolia Pulse:

```bash
# Required env
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export PULSE_ADDRESS=0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34
export KEEPER_PRIVATE_KEY=0x...   # any funded EOA

# Dry-run scan
bun run scripts/keeperhub-mark-expired.ts

# Execute the sweep
bun run scripts/keeperhub-mark-expired.ts --execute

# Target specific commitments
bun run scripts/keeperhub-mark-expired.ts --ids 21,25,26 --execute
```

Output is BigInt-safe single-object JSON on stdout — pipe it through `jq`
or any structured-log consumer.

## See also

- [`../scripts/keeperhub-mark-expired.ts`](../scripts/keeperhub-mark-expired.ts) — the local script
- [`../packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md`](../packages/plugins/pulse-skills/skills/keeperhub-bind/SKILL.md) — agent-facing skill
- [`../README.md`](../README.md) — repo overview, addresses, quickstart
- [`../SPEC.md`](../SPEC.md) — Pulse v0.x specification (markExpired semantics + reputation flows)
