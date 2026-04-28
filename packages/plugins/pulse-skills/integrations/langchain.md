# LangChain / LangGraph integration

LangChain agents take a list of `Tool` instances. Each Pulse skill becomes a
tool. The SKILL.md content is a great fit for `Tool.description` — concise
trigger conditions are exactly what LangChain's tool-selection routine needs.

## Install

```bash
npm install @pulse/sdk
```

## Tool definitions

```ts
import {DynamicStructuredTool} from "@langchain/core/tools";
import {z} from "zod";
import {commitIntent, revealIntent, encodeSwapAction, encodeHookData, fetchSealedReasoning} from "@pulse/sdk";

const wallet = /* set up viem wallet client at boot */;

export const pulseCommitTool = new DynamicStructuredTool({
  name: "pulse_commit",
  description: "Bind agent to a hashed action plus sealed reasoning at time T. The reveal must happen in [executeAfter, executeAfter + revealWindow). After that the commitment expires and reputation is slashed.",
  schema: z.object({
    agentId: z.string(),
    poolKey: z.object({
      currency0: z.string(),
      currency1: z.string(),
      fee: z.number(),
      tickSpacing: z.number(),
      hooks: z.string()
    }),
    swapParams: z.object({
      zeroForOne: z.boolean(),
      amountSpecified: z.string(),
      sqrtPriceLimitX96: z.string()
    }),
    nonce: z.string(),
    reasoningCID: z.string(),
    executeAfter: z.string(),
    revealWindow: z.string(),
    zgChatId: z.string()
  }),
  func: async (i) => {
    const reasoning = await fetchSealedReasoning({
      brokerUrl: process.env.ZG_BROKER_URL!,
      chatId: i.zgChatId,
      model: process.env.ZG_MODEL!,
      signerAddress: process.env.ZG_SIGNER_ADDRESS as `0x${string}`
    });

    const tx = await commitIntent(wallet, process.env.PULSE_ADDRESS as `0x${string}`, {
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

    return JSON.stringify({tx});
  }
});

export const pulseRevealTool = new DynamicStructuredTool({
  name: "pulse_reveal",
  description: "Close a Pulse commitment with matching nonce + actionData. Mismatched data slashes reputation.",
  schema: z.object({
    commitmentId: z.string(),
    nonce: z.string(),
    actionData: z.string()
  }),
  func: async (i) =>
    JSON.stringify({
      tx: await revealIntent(wallet, process.env.PULSE_ADDRESS as `0x${string}`, {
        commitmentId: BigInt(i.commitmentId),
        nonce: i.nonce as `0x${string}`,
        actionData: i.actionData as `0x${string}`
      })
    })
});
```

## LangGraph state machine pattern

Pulse maps cleanly onto LangGraph nodes:

```
[reason] → [commit] → [wait_for_executeAfter] → [reveal | swap_via_hook] → [done]
                                              ↘ [expire] (cron-triggered) → [slashed]
```

Each transition is a Tool call. The reveal step has two variants: direct
reveal (use `pulseRevealTool`) or hook-gated swap (build hookData via
`encodeHookData(commitmentId, nonce)` and submit through the v4 swap
router).

```ts
import {StateGraph} from "@langchain/langgraph";

const g = new StateGraph<PulseState>({channels: stateChannels});
g.addNode("reason", reasonNode);
g.addNode("commit", commitNode);
g.addNode("wait", waitNode);
g.addNode("reveal", revealNode);
g.addNode("expire", expireNode);
g.addEdge("reason", "commit");
g.addEdge("commit", "wait");
g.addConditionalEdges("wait", routeOnTime, {reveal: "reveal", expire: "expire"});
g.setEntryPoint("reason");
```

## Notes

- LangChain doesn't strictly need the SKILL.md files at runtime — but
  they're useful as system-prompt prefixes that teach the model when to
  use which tool. Load them with `await fs.readFile`.
- For Python LangChain (`langchain` PyPI), wrap `@pulse/sdk` calls in
  `subprocess` shells or build a thin Python client around viem-py / web3.py.
  The contract ABI lives in `packages/sdk/src/pulse.ts` as `PULSE_ABI`.
