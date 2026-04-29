# Integrating Pulse Protocol

You have an agent. You want it to commit before it acts so drift gets
caught. This is the 30-minute path from clone to first revealed commitment.

## What you need before you start

- Bun (`curl -fsSL https://bun.sh/install | bash`)
- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- An EOA with a small Sepolia ETH balance
  ([Alchemy faucet](https://www.alchemy.com/faucets/ethereum-sepolia)).
- (Optional, for iNFT path) An OG balance on 0G Galileo —
  [faucet](https://faucet.0g.ai/), 0.1 OG/day, plenty for one full integration.
- (Optional, for sealed inference) A 0G Compute API key from the
  [0G compute marketplace](https://compute-marketplace.0g.ai/).

## 1. Clone + install

```bash
git clone https://github.com/ss251/ethglobal-openagents
cd ethglobal-openagents
bun install
forge install
forge build && forge test     # 27/27 should pass
```

## 2. Set up your `.env`

Pulse uses an explicit `.env` loader (`scripts/_lib/env.ts`) that overrides
shell env — so a stale `AGENT_ID` from another bot's shell won't sign commits
for the wrong identity. Create `.env` at repo root with these keys:

```dotenv
# ── Eth Sepolia (chainId 11155111) ─────────────────────────────────────────
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

# Canonical Pulse Protocol deployment — use this if you only want to commit
# through Pulse without redeploying the contracts. To run your own Pulse,
# replace these with your own deploy addresses.
PULSE_ADDRESS=0xbe1b0051f5672F3CAAc38849B8Aaeeb51Dc6BF34
HOOK_ADDRESS=0x274b3c0f55c2db8c392418649c1eb3aad1ecc080
POOL_TOKEN0=0xB1e9c59B50D3b79cA09f4f9fd6ca5cC027EAeDDA
POOL_TOKEN1=0xC8d229E60C4a02fA49D060B1f0b08D956E6ef349
POOL_FEE=3000
POOL_TICK_SPACING=60
POOL_MANAGER=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
POOL_SWAP_TEST=0x9b6b46e2c869aa39918db7f52f5557fe577b6eee
ENS_PUBLIC_RESOLVER=0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5

# Your agent identity — fill these in:
AGENT_ID=                          # ERC-8004 IdentityRegistry token id
AGENT_PRIVATE_KEY=                 # 0x-prefixed 64-hex
AGENT_ENS_NAME=                    # e.g. yourname.eth on Sepolia
DEMO_TEE_SIGNER_KEY=               # 0x-prefixed; signs Pulse `signerProvider` payloads
WATCHER_KEY=                       # separate EOA for the slash-watcher daemon

# 0G Compute — get from https://compute-marketplace.0g.ai/
ZG_API_KEY=
ZG_BROKER_URL=
ZG_SIGNER_ADDRESS=
ZG_MODEL=qwen/qwen-2.5-7b-instruct

# ── 0G Galileo testnet (chainId 16602) — only if minting an iNFT ───────────
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_CHAIN_ID=16602
INFT_ADDRESS=                      # set after `forge script script/DeployINFT.s.sol`

# ── Uniswap Trading API (only for phase8-tradingapi-demo.ts) ───────────────
UNISWAP_TRADING_API_KEY=
```

You can also generate a fresh keypair for testing via:

```bash
bun run scripts/gen-keys.ts
```

That writes a `MNEMONIC.txt` and prints derived addresses + faucet links.

## 3. Register your agent on ERC-8004

Pulse uses the canonical ERC-8004 `IdentityRegistry` on Sepolia
(`0x8004A8…BD9e`). Register your agent EOA as an identity:

```bash
cast send 0x8004A818BFB912233c491871b3d84c89A494BD9e \
  "register(string,address)(uint256)" "yourname.eth" $AGENT_ADDR \
  --private-key $AGENT_PRIVATE_KEY \
  --rpc-url $SEPOLIA_RPC_URL
```

Capture the returned token id and write it as `AGENT_ID` in your `.env`.

## 4. (Optional) Bind ENS text records

If you want the `pulseProvenanceFromENS()` flow — anyone can resolve
`yourname.eth → (agentId, signerProvider, recent commitments)` — bind 5
text records on your ENS name:

```bash
bun run scripts/ens-bind-demo.ts
```

The agent commits a Pulse intent using *only* ENS-resolved data. Verifies
end-to-end.

## 5. Run your first Pulse-bound trade

```bash
bun run scripts/autonomous-trade.ts \
  --direction sell --base-amount 0.005 --min-price 1500
```

The script:

1. Generates 0G TEE-attested reasoning via qwen-2.5-7b
2. Computes `intentHash = keccak256(nonce || abi.encode(PoolKey, SwapParams))`
3. Submits `Pulse.commit(...)`
4. Waits `executeAfter`
5. Submits the swap with `hookData = abi.encode(commitmentId, nonce)` —
   `PulseGatedHook` atomically reveals
6. Emits a single JSON object on stdout with all tx hashes + final status

Status flips to `Revealed`, +100 ERC-8004 reputation. If the swap reverts
(insufficient balance, RPC hiccup, etc.), the JSON includes a `recovery`
block with the exact `pulse-retry.ts` invocation to settle the Pending
commitment inside its reveal window.

## 6. (Optional) Mint your agent as an ERC-7857 iNFT

The iNFT carries the agent's encrypted state, ENS namehash, ERC-8004 token
id, Pulse contract address, and full commitment history. Transfer or clone
it and the new owner inherits the rep trail.

```bash
# Deploy your own PulseAgentINFT on 0G Galileo
DEPLOYER_KEY=$AGENT_PRIVATE_KEY \
INFT_SIGNER=$DEMO_TEE_SIGNER_ADDR \
forge script script/DeployINFT.s.sol:DeployINFT \
  --rpc-url $ZG_RPC_URL --broadcast --legacy --skip-simulation

# Set the printed address as INFT_ADDRESS in your .env, then:
bun run scripts/inft-bind.ts \
  --commitments 1,2,3,4 \
  --description "my-agent-state-v1" \
  --set-ens-text
```

The script encrypts your agent state with AES-256-GCM, builds an ECDSA
preimage proof, mints, binds Pulse, records each commitment id, and
optionally writes the ENS text record `0g.inft` so downstream readers can
resolve the iNFT from your agent's name.

## 7. (Optional) Run the watcher daemon

For atomic-rollback gap recovery — the watcher catches drifted swaps that
the v4 hook reverts and locks them in as `Violated` via direct
`Pulse.reveal`:

```bash
nohup bun run scripts/watch-and-slash.ts > pulse-watcher.log 2>&1 &
```

## Programmatic use — `@pulse/sdk`

Every primitive the scripts use is exported from `@pulse/sdk`. From your
own TypeScript codebase:

```ts
import {
  // pulse commit/reveal/expire
  commitIntent, revealIntent, markExpiredIntent,
  intentHashForSwap, encodeHookData,
  // sealed reasoning
  sealedReason, fetchSealedReasoning,
  // ENS
  setAgentENSRecords, pulseProvenanceFromENS,
  // ERC-7857 iNFT
  encryptStateBlob, buildMintProof, mintINFT,
  bindPulseAgent, recordCommitment, readINFTState,
  // Trading API
  quoteSwap, executeFromQuote, pulseHookData,
} from "@pulse/sdk";
```

The SDK has zero env reads — you bring your own viem `WalletClient` +
`PublicClient` + `LocalAccount`. Same shape as `viem` itself.

## Per-framework adapters

Ready-to-paste recipes for popular agent frameworks live in
[`packages/plugins/pulse-skills/integrations/`](packages/plugins/pulse-skills/integrations/):

- [Anthropic API + Claude Agent SDK](packages/plugins/pulse-skills/integrations/anthropic-sdk.md)
- [Hermes (Nous Research)](packages/plugins/pulse-skills/integrations/hermes.md)
- [LangChain / LangGraph](packages/plugins/pulse-skills/integrations/langchain.md)
- [ElizaOS / Eliza](packages/plugins/pulse-skills/integrations/elizaos.md)
- [OpenClaw](packages/plugins/pulse-skills/integrations/openclaw.md)
- [Python (web3.py)](packages/plugins/pulse-skills/integrations/python.md)

Each recipe includes the tool-use schema, system-prompt fragment, and a
working code snippet using `@pulse/sdk`.

## Need help?

- [README.md](README.md) for the full project overview.
- [CHANGELOG.md](CHANGELOG.md) for release history.
- [docs/adr/0001-audit-perimeter.md](docs/adr/0001-audit-perimeter.md) for
  the architecture-decision record explaining the threat model.
- [`hermes-sandbox/AUTH_NOTES.md`](hermes-sandbox/AUTH_NOTES.md) if you're
  running the Hermes container demo.
