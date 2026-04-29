---
name: keeperhub-bind
description: "Sweep stuck-Pending Pulse commitments past their reveal window and call Pulse.markExpired(id) on each — slashing -500 ERC-8004 reputation per expired commitment. Use either as a one-shot local sweep (any funded EOA, permissionless) or as a KeeperHub-deployed cron workflow that replaces the off-chain expirer daemon Pulse used to need."
allowed-tools: Read, Bash, Grep
license: MIT
metadata:
  author: pulse
  version: '0.6.0'
  hermes:
    tags: [Pulse, KeeperHub, Expirer, ERC-8004, autonomous-agents]
    related_skills: [pulse-status-check, pulse-introspect, pulse-recover]
    requires_tools: [terminal]
---

# keeperhub-bind

The expirer is the single most-load-bearing piece of *operator infrastructure*
Pulse needs in production: every Pending commitment that nobody reveals or
expires costs the protocol cleanliness — `getStatus(id)` keeps reading
"Pending" forever and the agent's reputation never gets the slash it earned
for missing the window.

Pulse intentionally made `markExpired(uint256 id)` permissionless. **Anyone**
can sweep them. This skill picks up that handle from two angles:

1. **Local sweep** — `bun run scripts/keeperhub-mark-expired.ts --execute`
   from any EOA you control. No KeeperHub account required. The script
   reads the contract directly, filters by `commitTime > 0 && status ==
   Pending && now > revealDeadline`, and submits one transaction per
   stuck commitment with `gasLimit=500_000` (the giveFeedback-OOG floor).
2. **KeeperHub cron** — deploy
   [`keeperhub/workflows/pulse-mark-expired.json`](../../../../keeperhub/workflows/pulse-mark-expired.json)
   (cron `*/5 * * * *`). Same logic, runs in KeeperHub's keeper network on
   their schedule with their gas. Pulse's operator burden drops to zero.

## When to use

- After a stretch where the agent missed a reveal window and you want the
  reputation slash to actually post on chain (otherwise the commitment sits
  in Pending forever, distorting the `getStatus` view).
- During a debug session where a stuck Pending commitment is blocking the
  next test cycle (`pulse-introspect --commitment-id N` showed
  `overdueExpired=true`).
- Periodically — running this every 5 minutes as a cron is the right default
  for a healthy production deployment.

## When NOT to use

- The status of every recent commitment is `Revealed` or `Violated` — there
  is nothing to expire. The script's dry-run mode will tell you this and
  exit cleanly with `expirableCount=0`.
- The reveal window is still open (`inRevealWindow=true`). Use
  `pulse-recover` to actually settle the commitment correctly first.
- You want to slash a *cheating* agent (`Violated`) — that's
  `watch-and-slash.ts` territory, not this skill. `markExpired` only fires
  when nobody revealed in time.

## Two modes

### Mode A: dry-run sweep (default, safe)

```bash
bun run scripts/keeperhub-mark-expired.ts                # scan first 30 cids
bun run scripts/keeperhub-mark-expired.ts --ids 21,25,26 # specific ids only
```

Output shape:

```json
{
  "scenario": "keeperhub-mark-expired",
  "mode": "dry-run",
  "scannedCount": 30,
  "expirableCount": 8,
  "expirable": [
    {"id": "6", "status": "Pending", "revealDeadline": "1719520000"},
    ...
  ],
  "hint": "Re-run with --execute to actually call Pulse.markExpired(id) on each."
}
```

### Mode B: execute (writes on chain)

```bash
bun run scripts/keeperhub-mark-expired.ts --execute
bun run scripts/keeperhub-mark-expired.ts --ids 21 --execute
```

For each expirable commitment, submits one
`Pulse.markExpired(id)` transaction with `gasLimit=500_000`, waits for the
receipt, and emits the per-id results array — `markExpiredTx` on success,
`error` on failure. Failures don't abort the sweep; the loop is independent
per id.

## KeeperHub deployment

```bash
# 1. Verify the workflow JSON references the right Pulse address + RPC env
cat keeperhub/workflows/pulse-mark-expired.json

# 2. Deploy the workflow (replace COMMITTED_TOPIC_HASH with the
#    keccak256('Committed(...)') from deployments/sepolia.json)
kh workflow deploy keeperhub/workflows/pulse-mark-expired.json

# 3. The keeper now runs every 5 minutes; track via:
kh workflow status pulse-mark-expired
```

The local script is the canonical implementation — the workflow JSON is the
declarative version of the same three steps (scan → filter → loop call). If
the keeper network is down, the local fallback is `bun run
scripts/keeperhub-mark-expired.ts --execute`. Functionality is identical.

## Required env (local mode)

- `SEPOLIA_RPC_URL` — Sepolia RPC.
- `PULSE_ADDRESS` — `0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34` on Eth
  Sepolia.
- `KEEPER_PRIVATE_KEY` (preferred) or `AGENT_PRIVATE_KEY` (fallback) — any
  funded EOA. `markExpired` is permissionless; the keeper key never needs
  to be the agent's key. Keeper-only deployments should set
  `KEEPER_PRIVATE_KEY` and never expose `AGENT_PRIVATE_KEY` to the keeper.

## How the script avoids the dead-state trap

`markExpired` reverts on a non-existent commitment, but
`getCommitment(0)` returns the zero-struct (commitTime=0, status=Pending).
Without filtering, every cid past the highest-issued one would appear
"expirable" because `now > 0` and `status == Pending`. The script applies
`commitTime > 0n` as an existence guard before calling `markExpired`, so
the sweep stays linear-bounded by the actual issued cid count.

## Output contract

A single JSON object on stdout. All `bigint` fields serialize to strings
via the BigInt-safe writer in `scripts/_lib/output.ts`. Compose with `jq`:

```bash
bun run scripts/keeperhub-mark-expired.ts --execute \
  | jq '.results[] | select(.markExpiredTx) | "cid #\(.id) → \(.markExpiredTx)"'
```

## Composes with

- `pulse-introspect` — find candidate stuck commitments before sweeping.
- `pulse-status-check` — confirm a single commitment is still Pending past
  deadline before forcing the expire on it.
- The KeeperHub workflow JSON, which **is** this script, declared.
