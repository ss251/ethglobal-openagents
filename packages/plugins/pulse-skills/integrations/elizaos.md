# ElizaOS / eliza-style character integration

ElizaOS plugins ship as a set of action handlers a character can invoke. The
Pulse skills map naturally onto ElizaOS actions — one action per skill, all
backed by `@pulse/sdk`.

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
import type {Plugin, Action, IAgentRuntime, Memory, State} from "@elizaos/core";
import {createWalletClient, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {commitIntent, revealIntent, encodeHookData, encodeSwapAction, fetchSealedReasoning} from "@pulse/sdk";

const pulseCommit: Action = {
  name: "PULSE_COMMIT",
  description: "Bind the agent to a hashed pre-decision (see skills/pulse-commit/SKILL.md)",
  similes: ["lock in decision", "commit onchain", "stake reputation"],
  validate: async (rt, msg) => Boolean(rt.getSetting("PULSE_ADDRESS")),
  handler: async (rt, msg, state) => {
    const account = privateKeyToAccount(rt.getSetting("AGENT_PRIVATE_KEY") as `0x${string}`);
    const wallet = createWalletClient({account, chain: baseSepolia, transport: http(rt.getSetting("RPC_URL"))});

    // pull prior plan from state — your character logic chooses how
    const plan = state.recentMessagesData.find(m => m.content?.tool === "plan_swap")?.content as any;
    if (!plan) throw new Error("no swap plan in state to commit to");

    const reasoning = await fetchSealedReasoning({
      brokerUrl: rt.getSetting("ZG_BROKER_URL"),
      chatId: state.lastInferenceChatId,
      model: rt.getSetting("ZG_MODEL"),
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

    await rt.messageManager.createMemory({
      userId: msg.userId,
      content: {text: `Pulse commit: ${tx}`, tx, action: "PULSE_COMMIT"},
      roomId: msg.roomId,
      agentId: rt.agentId
    });
  },
  examples: [
    [
      {user: "{{user1}}", content: {text: "lock in the trade"}},
      {user: "{{agent}}", content: {text: "Committing onchain via Pulse.", action: "PULSE_COMMIT"}}
    ]
  ]
};

const pulseReveal: Action = {
  name: "PULSE_REVEAL",
  description: "Close a pending Pulse commitment (see skills/pulse-reveal/SKILL.md)",
  validate: async () => true,
  handler: async (rt, msg, state) => {
    // pull commitmentId/nonce/actionData from a memory record created at commit time
    // ... wallet + revealIntent(...) ...
  },
  examples: []
};

export const pulsePlugin: Plugin = {
  name: "pulse",
  description: "Galaxy-brain-resistant onchain commitments",
  actions: [pulseCommit, pulseReveal]
};
```

## Character config

```yaml
# characters/myagent.character.yaml
plugins:
  - pulse
settings:
  PULSE_ADDRESS: "0x..."
  AGENT_ID: "42"
  AGENT_PRIVATE_KEY: "${AGENT_PRIVATE_KEY}"
  RPC_URL: "${RPC_URL}"
  ZG_BROKER_URL: "${ZG_BROKER_URL}"
  ZG_MODEL: "deepseek-reasoner"
  ZG_SIGNER_ADDRESS: "${ZG_SIGNER_ADDRESS}"
bio:
  - "I make commitments before I act so users can audit me."
style:
  all:
    - "Reference my Pulse commitment when defending a decision."
```

The SKILL.md files in the bundle inform character bios — copy excerpts into
the `style` and `lore` sections so the model knows *why* it's committing.

## Notes

- ElizaOS's progressive plugin loading means the SKILL.md prose lives near
  the actions; the character only sees full skill content when the action is
  actually triggered.
- For the v4 hook path, add a `PULSE_GATED_SWAP` action that uses
  `encodeHookData(commitmentId, nonce)` and submits via your existing v4 swap
  helper.
