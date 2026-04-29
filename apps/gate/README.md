# apps/gate — Pulse Gate reference frontend

Single-file static page that demos the **read** side of Pulse: paste an
ERC-8004 agent id, see whether they pass the Pulse-tagged feedback
threshold, with a click-through to the on-chain reads that produced
the verdict.

This is the **reference consumer** for protocols that want to gate
behavior on Pulse reputation. It exists so the answer to "how do I read
Pulse rep?" is "clone this folder."

## Stack

- Single `index.html`, no build step, no framework.
- [viem](https://viem.sh) loaded from `esm.sh` CDN.
- Reads the canonical ERC-8004 `ReputationRegistry.getSummary` directly
  on Eth Sepolia (or any chain via `?rpc=...`).
- Optionally reads `PulseGatedGate.threshold()` + `tag2Filter()` if a
  deployed gate address is passed via `?gate=0x...`.

## Run it locally

```bash
cd apps/gate
python3 -m http.server 5174
open http://127.0.0.1:5174/?agent=3906        # pulseagent.eth
open http://127.0.0.1:5174/?agent=999999      # untracked agent
```

No `npm install`, no `bun install`, no Vercel deploy. Drop the file
anywhere that serves static HTML and it works.

## URL params

| Param | Purpose | Default |
| --- | --- | --- |
| `agent` | ERC-8004 agent id to pre-fill the input | (empty) |
| `gate` | `PulseGatedGate` contract address to read threshold/tag2 from | (empty — falls back to direct registry read with `threshold=50`) |
| `pulse` | Pulse contract address (used as the single client filter) | `0xbe1b…BF34` (Eth Sepolia) |
| `threshold` | Override threshold when no `gate` is set | `50` |
| `rpc` | RPC URL | publicnode Sepolia |

## What it actually does on click

```ts
const REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713"; // canonical ERC-8004
client.readContract({
    address: REGISTRY,
    abi: ["function getSummary(uint256, address[], string, string) view returns (uint64, int128, uint8)"],
    functionName: "getSummary",
    args: [agentId, [PULSE], "pulse", tag2Filter],
});
```

Returns `(count, summaryValue, decimals)` — the average of all
Pulse-emitted feedback values, scaled to mode decimals. Passes the
gate if `count > 0 && summaryValue >= threshold`.

## Why a single HTML file

This is meant to be **the smallest possible reference integration**.
A protocol team deciding "should we gate our agent allowlist on Pulse?"
clones this file, points it at their RPC + their gate address, and
they're done. No `package.json`, no compile step, no build cache, no
deploy infra.

If you want a fancier UI (recent commitments timeline, agent-by-ENS
lookup, multi-chain rollup), build it on top — the on-chain read
surface is the hard part and it's already done.

## Deploy a gate alongside this

```bash
# Set in .env
export REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713
export PULSE_ADDRESS=0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34
export GATE_THRESHOLD=50

forge script script/DeployGate.s.sol --rpc-url sepolia --broadcast
# prints: PulseGatedGate deployed: 0x...

open "http://127.0.0.1:5174/?agent=3906&gate=0x..."
```

Then `IPulseGate(gate).assertGate(agentId)` from any contract gates a
function on Pulse reputation:

```solidity
import {IPulseGate} from "./gates/PulseGatedGate.sol";

contract MyAgentAllowlist {
    IPulseGate public immutable pulseGate;

    function settleIntent(uint256 agentId, bytes calldata intent) external {
        pulseGate.assertGate(agentId); // reverts if rep < threshold
        // ... rest of settle logic
    }
}
```

That's the whole consumption story.
