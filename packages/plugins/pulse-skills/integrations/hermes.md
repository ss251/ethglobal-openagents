# Hermes integration

Hermes-style agents typically expose a fly-by-wire toolset: deterministic
TypeScript / Python tools that the agent can call by name. Pulse skills are a
clean fit — the SKILL.md instructs the agent on *when* to use the tools, the
tools themselves wrap `@pulse/sdk`.

## Install skills

If your Hermes setup already supports `npx skills add` (Vercel's skills.sh
CLI):

```bash
npx skills add ss251/ethglobal-openagents
```

Otherwise just clone the repo and copy `packages/plugins/pulse-skills/skills/`
into your Hermes skill directory.

## Tool definitions (TypeScript)

```ts
import {tool} from "hermes-agent"; // example
import {z} from "zod";
import {commitIntent, revealIntent, encodeSwapAction, intentHashForSwap, fetchSealedReasoning} from "@pulse/sdk";

export const pulseCommitTool = tool({
  name: "pulse_commit",
  description: "Bind agent to a hashed action with sealed reasoning. See SKILL.md for when.",
  parameters: z.object({
    agentId: z.coerce.bigint(),
    poolKey: z.object({
      currency0: z.string(),
      currency1: z.string(),
      fee: z.number(),
      tickSpacing: z.number(),
      hooks: z.string()
    }),
    swapParams: z.object({
      zeroForOne: z.boolean(),
      amountSpecified: z.coerce.bigint(),
      sqrtPriceLimitX96: z.coerce.bigint()
    }),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    reasoningCID: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    executeAfter: z.coerce.bigint(),
    revealWindow: z.coerce.bigint()
  }),
  async execute(input, ctx) {
    const reasoning = await fetchSealedReasoning({
      brokerUrl: ctx.env.ZG_BROKER_URL,
      chatId: ctx.lastInferenceChatId, // Hermes typically tracks this
      model: ctx.env.ZG_MODEL,
      signerAddress: ctx.env.ZG_SIGNER_ADDRESS
    });

    return commitIntent(ctx.wallet, ctx.env.PULSE_ADDRESS, {
      agentId: input.agentId,
      actionData: encodeSwapAction(input.poolKey as any, input.swapParams as any),
      nonce: input.nonce as `0x${string}`,
      reasoning,
      reasoningCID: input.reasoningCID as `0x${string}`,
      executeAfter: input.executeAfter,
      revealWindow: input.revealWindow
    });
  }
});

export const pulseRevealTool = tool({
  name: "pulse_reveal",
  description: "Close a Pulse commitment by revealing matching nonce + actionData.",
  parameters: z.object({
    commitmentId: z.coerce.bigint(),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    actionData: z.string().regex(/^0x[0-9a-fA-F]*$/)
  }),
  async execute(input, ctx) {
    return revealIntent(ctx.wallet, ctx.env.PULSE_ADDRESS, {
      commitmentId: input.commitmentId,
      nonce: input.nonce as `0x${string}`,
      actionData: input.actionData as `0x${string}`
    });
  }
});
```

## Hermes flow guidance

1. Agent reasons → `inference()` returns text + chatId.
2. Agent calls `pulse_commit` with the chatId baked into context.
3. Hermes scheduler queues a reveal at `executeAfter` (use whatever cron /
   delayed-task primitive Hermes provides).
4. At fire time, agent calls `pulse_reveal` (or `pulse_swap_via_hook` if
   you've wired the v4 hook).

The SKILL.md files contain the prompts that teach the model when each tool
is appropriate. Keep them in `system_prompt_extras` or as RAG-loaded markdown.

## Reading state

Hermes agents that need to inspect commitment state can hit a read-only
helper without an additional SKILL.md tool definition — the
`pulse-status-check` skill describes the pattern, and the agent can invoke
your generic `read_contract` tool with `getStatus` / `getCommitment` calls.
