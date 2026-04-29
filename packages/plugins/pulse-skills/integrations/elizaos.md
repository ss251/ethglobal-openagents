# ElizaOS / eliza-style character integration

ElizaOS plugins ship as a `Plugin` object exposing actions, providers,
evaluators, and services. Pulse skills map onto ElizaOS actions — one
action per skill, all backed by `@pulse/sdk`.

This recipe is verified against the current v1.x plugin reference at
[docs.elizaos.ai/plugins/reference.md](https://docs.elizaos.ai/plugins/reference.md)
and [character interface](https://docs.elizaos.ai/agents/character-interface.md)
docs as of 2026-Q1.

## Install

```bash
npm install @pulse/sdk
# in your eliza repo
git submodule add https://github.com/ss251/ethglobal-openagents .eliza/skills/pulse
```

Or use skills.sh if your ElizaOS fork supports it:

```bash
npx skills add ss251/ethglobal-openagents
```

## Plugin scaffold

```ts
// plugins/pulse/index.ts
import type {Plugin, Action, IAgentRuntime, Memory, State, ActionResult} from "@elizaos/core";
import {createWalletClient, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {sepolia} from "viem/chains";
import {commitIntent, revealIntent, encodeHookData, encodeSwapAction, fetchSealedReasoning} from "@pulse/sdk";

const pulseCommit: Action = {
  name: "PULSE_COMMIT",
  description: "Bind the agent to a hashed pre-decision (see skills/pulse-commit/SKILL.md)",
  similes: ["lock in decision", "commit onchain", "stake reputation"],
  validate: async (rt: IAgentRuntime) => Boolean(rt.getSetting("PULSE_ADDRESS")),
  handler: async (rt, msg, state): Promise<ActionResult> => {
    const account = privateKeyToAccount(rt.getSetting("AGENT_PRIVATE_KEY") as `0x${string}`);
    const wallet = createWalletClient({account, chain: sepolia, transport: http(rt.getSetting("SEPOLIA_RPC_URL"))});

    // pull prior plan from state — your character logic chooses how
    const plan = state?.recentMessagesData?.find((m: Memory) => (m.content as any)?.tool === "plan_swap")?.content as any;
    if (!plan) return {success: false, text: "no swap plan in state to commit to"};

    const reasoning = await fetchSealedReasoning({
      brokerUrl: rt.getSetting("ZG_BROKER_URL")!,
      chatId: (state as any).lastInferenceChatId,
      model: rt.getSetting("ZG_MODEL")!,
      signerAddress: rt.getSetting("ZG_SIGNER_ADDRESS") as `0x${string}`
    });

    const tx = await commitIntent(wallet, rt.getSetting("PULSE_ADDRESS") as `0x${string}`, {
      agentId: BigInt(rt.getSetting("AGENT_ID")!),
      actionData: encodeSwapAction(plan.poolKey, plan.swapParams),
      nonce: plan.nonce,
      reasoning,
      reasoningCID: plan.reasoningCID,
      executeAfter: plan.executeAfter,
      revealWindow: plan.revealWindow
    });

    return {
      success: true,
      text: `Pulse commit landed: ${tx}`,
      data: {tx, plan}
    };
  },
  examples: [
    [
      {name: "{{user1}}", content: {text: "lock in the trade"}},
      {name: "Pulse", content: {text: "Committing onchain via Pulse.", actions: ["PULSE_COMMIT"]}}
    ]
  ]
};

const pulseReveal: Action = {
  name: "PULSE_REVEAL",
  description: "Close a pending Pulse commitment (see skills/pulse-reveal/SKILL.md)",
  validate: async () => true,
  handler: async (rt, msg, state): Promise<ActionResult> => {
    // pull commitmentId/nonce/actionData from a memory record created at commit time
    // ... wallet + revealIntent(...) ...
    return {success: true, text: "revealed"};
  },
  examples: []
};

export const pulsePlugin: Plugin = {
  name: "@openagents/pulse",
  description: "Galaxy-brain-resistant onchain commitments",
  actions: [pulseCommit, pulseReveal],
  providers: [],
  evaluators: [],
  services: []
};
```

## Character file (TypeScript)

ElizaOS v1 uses TypeScript-defined characters; the YAML form is not in
current docs. `secrets` is **top-level**, not nested under `settings`.
Plugin entries are package names or registered plugin slugs.

```ts
// characters/myagent.character.ts
import type {Character} from "@elizaos/core";

export const character: Character = {
  name: "Pulse",
  bio: ["I make commitments before I act so users can audit me."],
  style: {
    all: ["Reference my Pulse commitment when defending a decision."]
  },
  plugins: ["@elizaos/plugin-openai", "@openagents/pulse"],
  secrets: {
    PULSE_ADDRESS: process.env.PULSE_ADDRESS,
    AGENT_ID: process.env.AGENT_ID,
    AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
    ZG_BROKER_URL: process.env.ZG_BROKER_URL,
    ZG_MODEL: process.env.ZG_MODEL ?? "qwen/qwen-2.5-7b-instruct",
    ZG_SIGNER_ADDRESS: process.env.ZG_SIGNER_ADDRESS,
    INFT_ADDRESS: process.env.INFT_ADDRESS,
    AGENT_ENS_NAME: process.env.AGENT_ENS_NAME ?? "pulseagent.eth",
    DEMO_TEE_SIGNER_KEY: process.env.DEMO_TEE_SIGNER_KEY
  }
};
```

The SKILL.md files in the bundle inform character bios — copy excerpts into
the `style` and `bio` sections so the model knows *why* it's committing.

## ERC-7857 iNFT — `PULSE_INFT_MINT` action

Add a `PULSE_INFT_MINT` action so the character can mint its own encrypted
state as a transferable iNFT on 0G Galileo. The action wraps `@pulse/sdk`
directly:

```ts
import type {Action, ActionResult} from "@elizaos/core";
import {
  encryptStateBlob, buildMintProof, mintINFT,
  bindPulseAgent, recordCommitment, readINFTState,
  INFT_HUMAN_READABLE_ABI
} from "@pulse/sdk";
import {createPublicClient, createWalletClient, http, namehash, defineChain} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const zgGalileo = defineChain({
  id: 16602, name: "0G Galileo Testnet",
  nativeCurrency: {name: "OG", symbol: "OG", decimals: 18},
  rpcUrls: {default: {http: ["https://evmrpc-testnet.0g.ai"]}}
});

export const pulseInftMintAction: Action = {
  name: "PULSE_INFT_MINT",
  description:
    "Mint the agent's encrypted state as an ERC-7857 iNFT on 0G Galileo. " +
    "Binds ENS, ERC-8004 id, and recent Pulse commitments into one " +
    "transferable NFT.",
  similes: ["mint iNFT", "tokenize agent state", "publish agent on 0G"],
  validate: async (rt) => Boolean(rt.getSetting("INFT_ADDRESS")),
  handler: async (rt, msg, state): Promise<ActionResult> => {
    const agent = privateKeyToAccount(rt.getSetting("AGENT_PRIVATE_KEY") as `0x${string}`);
    const tee = privateKeyToAccount(rt.getSetting("DEMO_TEE_SIGNER_KEY") as `0x${string}`);
    const inft = rt.getSetting("INFT_ADDRESS") as `0x${string}`;

    const pub = createPublicClient({chain: zgGalileo, transport: http()});
    const wal = createWalletClient({account: agent, chain: zgGalileo, transport: http()});

    const blob = encryptStateBlob(JSON.stringify(state ?? {}));
    const proof = await buildMintProof(tee, inft, blob.dataHash);
    const mintTx = await mintINFT(wal, {
      inftAddress: inft, proofs: [proof],
      dataDescriptions: ["eliza-character-state-v1"], to: agent.address
    });
    await pub.waitForTransactionReceipt({hash: mintTx});

    const tokenId = await pub.readContract({
      address: inft, abi: INFT_HUMAN_READABLE_ABI, functionName: "totalSupply"
    }) as bigint;
    await bindPulseAgent(wal, {
      inftAddress: inft, tokenId,
      agentId: BigInt(rt.getSetting("AGENT_ID")!),
      ensNode: namehash(rt.getSetting("AGENT_ENS_NAME") ?? "pulseagent.eth"),
      pulse: rt.getSetting("PULSE_ADDRESS") as `0x${string}`,
      pulseChainId: 11155111n
    });

    return {
      success: true,
      text: `Minted iNFT tokenId ${tokenId} on 0G Galileo`,
      data: {tokenId: tokenId.toString(), dataHash: blob.dataHash, sealedKey: blob.keyHex}
    };
  },
  examples: [
    [
      {name: "{{user1}}", content: {text: "Mint my agent state as an iNFT on 0G"}},
      {name: "Pulse", content: {text: "Minting iNFT now.", actions: ["PULSE_INFT_MINT"]}}
    ]
  ]
};
```

## Notes

- ElizaOS's progressive plugin loading means the SKILL.md prose lives near
  the actions; the character only sees full skill content when the action is
  actually triggered.
- For the v4 hook path, add a `PULSE_GATED_SWAP` action that uses
  `encodeHookData(commitmentId, nonce)` and submits via your existing v4 swap
  helper.
- ElizaOS Plugin objects can also expose `services`, `providers`,
  `evaluators`, and `routes` — see [docs.elizaos.ai/plugins/components.md](https://docs.elizaos.ai/plugins/components.md) for the full surface.
