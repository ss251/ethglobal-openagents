# OpenClaw integration

OpenClaw splits agent capabilities into two layers: **skills** (pure
markdown SKILL.md files that teach the agent *when* to act) and **plugins**
(TypeScript code that expose the actual tools). Pulse fits this split
cleanly — the `pulse-skills` SKILL.md files plug straight into OpenClaw's
skill-loader, and a companion `openclaw-pulse` plugin exposes the
`pulse_commit` / `pulse_reveal` / `pulse_inft_mint` tools that wrap
`@pulse/sdk`.

This recipe is verified against the current docs at
[docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills),
[docs.openclaw.ai/plugins/building-plugins](https://docs.openclaw.ai/plugins/building-plugins),
and the [skill-format spec](https://github.com/openclaw/clawhub/blob/main/docs/skill-format.md)
as of 2026-Q1.

## Install the skills (markdown only — no code)

```bash
# canonical OpenClaw installer (pulls from ClawHub if published)
openclaw skills install pulse-commit pulse-reveal pulse-status-check \
  pulse-gated-swap pulse-recover pulse-introspect pulse-inft \
  pulse-autonomous-trade sealed-inference-with-pulse
```

Or load from this GitHub repo directly via the clawhub CLI:

```bash
npx skills add https://github.com/ss251/ethglobal-openagents \
  --skill pulse-commit
# repeat for each skill
```

OpenClaw's load order is `<workspace>/skills` →
`<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` →
bundled. Drop the SKILL.md files into any of those tiers.

## Companion plugin — `openclaw-pulse`

Skills are pure markdown. The actual tools live in a plugin that ships
alongside. Plugin tools use `@sinclair/typebox` for parameter schemas (not
JSON-schema, not Zod).

```ts
// packages/plugins/openclaw-pulse/src/index.ts
import {definePluginEntry} from "openclaw";
import {Type} from "@sinclair/typebox";
import {createWalletClient, createPublicClient, http, namehash, defineChain} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {
  commitIntent, revealIntent, fetchSealedReasoning, encodeSwapAction,
  encryptStateBlob, buildMintProof, mintINFT,
  bindPulseAgent, recordCommitment, readINFTState,
  INFT_HUMAN_READABLE_ABI
} from "@pulse/sdk";

const zgGalileo = defineChain({
  id: 16602, name: "0G Galileo Testnet",
  nativeCurrency: {name: "OG", symbol: "OG", decimals: 18},
  rpcUrls: {default: {http: ["https://evmrpc-testnet.0g.ai"]}}
});

export default definePluginEntry({
  name: "openclaw-pulse",
  version: "0.5.0",

  register(api) {
    const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
    const tee     = privateKeyToAccount(process.env.DEMO_TEE_SIGNER_KEY as `0x${string}`);
    const sepWal  = createWalletClient({account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL)});
    const zgPub   = createPublicClient({chain: zgGalileo, transport: http()});
    const zgWal   = createWalletClient({account, chain: zgGalileo, transport: http()});

    api.registerTool({
      name: "pulse_commit",
      description:
        "Bind agent to a hashed action plus sealed reasoning. " +
        "See pulse-commit/SKILL.md for when.",
      parameters: Type.Object({
        agentId: Type.String(),
        poolKey: Type.Object({
          currency0: Type.String(),
          currency1: Type.String(),
          fee: Type.Number(),
          tickSpacing: Type.Number(),
          hooks: Type.String()
        }),
        swapParams: Type.Object({
          zeroForOne: Type.Boolean(),
          amountSpecified: Type.String(),
          sqrtPriceLimitX96: Type.String()
        }),
        nonce: Type.String(),
        reasoningCID: Type.String(),
        executeAfter: Type.String(),
        revealWindow: Type.String(),
        zgChatId: Type.String()
      }),
      execute: async (i) => {
        const reasoning = await fetchSealedReasoning({
          brokerUrl: process.env.ZG_BROKER_URL!,
          chatId: i.zgChatId,
          model: process.env.ZG_MODEL!,
          signerAddress: process.env.ZG_SIGNER_ADDRESS as `0x${string}`
        });
        return commitIntent(sepWal, process.env.PULSE_ADDRESS as `0x${string}`, {
          agentId: BigInt(i.agentId),
          actionData: encodeSwapAction(i.poolKey as any, {
            zeroForOne: i.swapParams.zeroForOne,
            amountSpecified: BigInt(i.swapParams.amountSpecified),
            sqrtPriceLimitX96: BigInt(i.swapParams.sqrtPriceLimitX96)
          }),
          nonce: i.nonce as `0x${string}`,
          reasoning,
          reasoningCID: i.reasoningCID as `0x${string}`,
          executeAfter: BigInt(i.executeAfter),
          revealWindow: BigInt(i.revealWindow)
        });
      }
    });

    api.registerTool({
      name: "pulse_reveal",
      description: "Close a Pulse commitment with matching nonce + actionData.",
      parameters: Type.Object({
        commitmentId: Type.String(),
        nonce: Type.String(),
        actionData: Type.String()
      }),
      execute: async (i) =>
        revealIntent(sepWal, process.env.PULSE_ADDRESS as `0x${string}`, {
          commitmentId: BigInt(i.commitmentId),
          nonce: i.nonce as `0x${string}`,
          actionData: i.actionData as `0x${string}`
        })
    });

    api.registerTool({
      name: "pulse_inft_mint",
      description:
        "Mint the agent's encrypted state as an ERC-7857 iNFT on 0G " +
        "Galileo, binding ENS, ERC-8004 id, and recent Pulse commitments " +
        "into one transferable NFT.",
      parameters: Type.Object({
        stateBlob: Type.String(),
        description: Type.String(),
        commitmentIds: Type.Optional(Type.Array(Type.String()))
      }),
      execute: async ({stateBlob, description, commitmentIds = []}) => {
        const inft = process.env.INFT_ADDRESS as `0x${string}`;
        const blob = encryptStateBlob(stateBlob);
        const proof = await buildMintProof(tee, inft, blob.dataHash);
        const mintTx = await mintINFT(zgWal, {
          inftAddress: inft, proofs: [proof],
          dataDescriptions: [description], to: account.address
        });
        await zgPub.waitForTransactionReceipt({hash: mintTx});

        const tokenId = await zgPub.readContract({
          address: inft, abi: INFT_HUMAN_READABLE_ABI, functionName: "totalSupply"
        }) as bigint;

        await bindPulseAgent(zgWal, {
          inftAddress: inft, tokenId,
          agentId: BigInt(process.env.AGENT_ID!),
          ensNode: namehash(process.env.AGENT_ENS_NAME!),
          pulse: process.env.PULSE_ADDRESS as `0x${string}`,
          pulseChainId: 11155111n
        });

        for (const cid of commitmentIds) {
          await recordCommitment(zgWal, {
            inftAddress: inft, tokenId,
            commitmentId: BigInt(cid),
            pulseChainId: 11155111n
          });
        }

        return await readINFTState(zgPub, inft, tokenId);
      }
    });
  }
});
```

## Plugin manifest

```json
// packages/plugins/openclaw-pulse/openclaw.plugin.json
{
  "name": "openclaw-pulse",
  "version": "0.5.0",
  "description": "Pulse commit/reveal + ERC-7857 iNFT tools for OpenClaw agents",
  "entry": "dist/index.js",
  "skills": [
    "pulse-commit",
    "pulse-reveal",
    "pulse-status-check",
    "pulse-gated-swap",
    "pulse-recover",
    "pulse-introspect",
    "pulse-inft",
    "pulse-autonomous-trade",
    "sealed-inference-with-pulse"
  ]
}
```

The `skills` array tells OpenClaw which SKILL.md files this plugin's tools
back. The agent reads the SKILL.md to know *when* to call a tool; the
plugin's `execute` function does the work.

## Why split skills from tools

OpenClaw's design separates **agent-facing prose** (SKILL.md) from
**executable code** (plugin tools). It means:

- Skills can be installed without code review — they're just markdown
  prompts that teach the agent.
- Plugins are versioned independently and audited as code.
- A skill can be backed by *multiple* plugin implementations — different
  chains, different RPCs, different signing strategies.

This shape is what most current agent frameworks are converging on.
