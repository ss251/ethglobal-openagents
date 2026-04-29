---
name: pulse-inft
description: "Mint or update an ERC-7857 iNFT on 0G Galileo that anchors the agent's encrypted state, ENS identity, ERC-8004 token id, Pulse contract address, and recent commitment history into one transferable NFT. Use when the user wants the agent's identity + reasoning trail to be ownable, transferable, or composable across chains."
allowed-tools: Read, Bash, Grep
license: MIT
metadata:
  author: pulse
  version: '0.4.0'
  hermes:
    tags: [Pulse, ERC-7857, iNFT, 0G, Cross-chain, agent-identity]
    related_skills: [pulse-autonomous-trade, pulse-status-check, pulse-introspect, sealed-inference-with-pulse]
    requires_tools: [terminal]
---

# pulse-inft

ERC-7857 (the 0G iNFT standard) lets an agent's encrypted state — config,
memories, model references, commitment history — live as a transferable NFT
on 0G chain. Pulse Protocol issues one iNFT per agent, hashed and anchored
through the standard ERC-7857 mint flow, with two Pulse-specific extensions:

- `bindPulseAgent(tokenId, agentId, ensNode, pulse, pulseChainId)` — links
  the iNFT to its Pulse identity stack (ERC-8004 token id, ENS namehash,
  Pulse contract address, chain).
- `recordCommitment(tokenId, commitmentId, pulseChainId)` — appends a Pulse
  commitment id to the iNFT's on-chain history. Transferring or cloning the
  iNFT carries the full reputation trail with it.

The encrypted blob lives off-chain (0G Storage indexer at
`https://indexer-storage-testnet-turbo.0g.ai`); the contract anchors only
the AES-256-GCM ciphertext hash. A TEE-attested ECDSA proof gates mint /
update / transfer / clone — same trust anchor as Pulse's `signerProvider`,
so an integrator wires Pulse + iNFT against one signing key.

## When to use

- The user wants the agent's identity (ENS + ERC-8004 + Pulse history) to
  be ownable / transferable / sellable.
- A new agent is being deployed and wants its initial state minted under a
  fresh tokenId on 0G.
- An existing iNFT needs a fresh commitment id appended (after every Pulse
  commit, optionally call `recordCommitment` on the iNFT to keep the trail
  synced).

## Procedure

```bash
# Mint the iNFT and bind it to pulseagent.eth + ERC-8004 #3906 + Pulse on
# Sepolia, recording the agent's last 9 commitments in one go:
bun run scripts/inft-bind.ts \
  --commitments 9,12,13,14,15,21,23,24,25 \
  --description "pulse-agent-state-v1" \
  --set-ens-text
```

Required env (auto-loaded from `.env`):

| var                       | what                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `AGENT_PRIVATE_KEY`       | wallet that owns `pulseagent.eth` on Sepolia                                               |
| `INFT_ADDRESS`            | deployed `PulseAgentINFT` on 0G Galileo (`forge script script/DeployINFT.s.sol`)           |
| `DEMO_TEE_SIGNER_KEY`     | TEE signer key that matches the iNFT's `signerProvider`                                    |
| `PULSE_ADDRESS`, `AGENT_ID`, `AGENT_ENS_NAME` | already in `.env` from prior Pulse setup                                |
| `ZG_RPC_URL` (optional)   | defaults to `https://evmrpc-testnet.0g.ai`                                                 |

The script:

1. Encrypts the agent state blob with AES-256-GCM, hashes the ciphertext.
2. Builds an ECDSA preimage proof signed by the TEE key, matching the
   on-chain `_verifyPreimage` digest exactly.
3. Calls `mint` with `[proof], [description], owner=agent`.
4. Calls `bindPulseAgent` to link the new tokenId to the Pulse identity.
5. Calls `recordCommitment` for each comma-separated id in `--commitments`.
6. Optionally writes the ENS text record `0g.inft = 0g-galileo:16602:<inft>:<tokenId>`
   on Sepolia — so existing `pulseProvenanceFromENS()` readers can discover
   the iNFT from the agent's ENS name without a hardcoded address.
7. Emits a single JSON object on stdout with all tx hashes and explorer URLs.

## Why this matters

Pulse already proves the agent's *current decision* is bound to a sealed
reasoning hash. The iNFT extends that to the agent's *whole identity*: every
commit is part of a transferable, encrypted ledger that lives on 0G chain.
A new owner inherits the rep history and can keep committing under the same
agent identity. This is the v0.4 prize-track surface for 0G's "Best
Autonomous Agents, Swarms & iNFT Innovations" track.

## Failure modes

| Symptom                                          | Cause                                  | Fix                                                  |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| `agent X has 0 OG on 0G Galileo`                 | wallet not funded                      | Claim from `https://faucet.0g.ai/` (0.1 OG/day)      |
| `signer mismatch`                                | TEE key doesn't match contract signer  | Re-deploy with `INFT_SIGNER=<DEMO_TEE_SIGNER addr>`  |
| `mint reverted: 0x...`                           | proof bytes wrong / digest mismatch    | Inspect `preimageDigest` vs contract `_verifyPreimage` |
| `INFT_ADDRESS not set`                           | run deploy first                       | `forge script script/DeployINFT.s.sol --rpc-url $ZG_RPC_URL --broadcast --legacy --skip-simulation` |
