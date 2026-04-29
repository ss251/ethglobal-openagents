# LangChain / LangGraph integration

LangChain JS v1.0 (current as of 2026-Q1) consolidated tool creation under
the `tool()` factory and the prebuilt agent under `createAgent`, both
exported from the unified `langchain` package. This recipe uses the v1
canonical shapes; the v0.2-era `DynamicStructuredTool` + `createReactAgent`
patterns still run for back-compat but aren't shown in current quickstarts.

Sources verified: [docs.langchain.com/oss/javascript/langchain/overview](https://docs.langchain.com/oss/javascript/langchain/overview), [docs.langchain.com/oss/javascript/langgraph/graph-api](https://docs.langchain.com/oss/javascript/langgraph/graph-api).

## Install

```bash
npm install langchain @langchain/langgraph @pulse/sdk zod
```

## Tool definitions (v1 `tool()` factory)

```ts
import {tool} from "langchain";
import * as z from "zod";
import {commitIntent, revealIntent, encodeSwapAction, encodeHookData, fetchSealedReasoning} from "@pulse/sdk";

// One viem wallet client + viem public client at boot — pass via closure
// or via a shared context object the tools capture.
const wallet = /* createWalletClient({...}) */;

export const pulseCommitTool = tool(
  async (i) => {
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
  },
  {
    name: "pulse_commit",
    description:
      "Bind agent to a hashed action plus sealed reasoning at time T. " +
      "The reveal must happen in [executeAfter, executeAfter + revealWindow). " +
      "After that the commitment expires and reputation is slashed.",
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
    })
  }
);

export const pulseRevealTool = tool(
  async (i) =>
    JSON.stringify({
      tx: await revealIntent(wallet, process.env.PULSE_ADDRESS as `0x${string}`, {
        commitmentId: BigInt(i.commitmentId),
        nonce: i.nonce as `0x${string}`,
        actionData: i.actionData as `0x${string}`
      })
    }),
  {
    name: "pulse_reveal",
    description:
      "Close a Pulse commitment with matching nonce + actionData. " +
      "Mismatched data slashes reputation.",
    schema: z.object({
      commitmentId: z.string(),
      nonce: z.string(),
      actionData: z.string()
    })
  }
);
```

## ReAct-style agent (v1 `createAgent`)

```ts
import {createAgent} from "langchain";

const agent = createAgent({
  model: "claude-sonnet-4-6",
  tools: [pulseCommitTool, pulseRevealTool, pulseStatusTool, pulseInftMintTool]
});

const result = await agent.invoke({
  messages: [{role: "user", content: "Sell 0.005 pETH for at least 1500 pUSD."}]
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
import {StateGraph, StateSchema, MessagesValue, START, END} from "@langchain/langgraph";
import * as z from "zod";

const PulseState = new StateSchema({
  messages: MessagesValue,
  commitmentId: z.string().optional(),
  executeAfter: z.bigint().optional(),
  status: z.enum(["pending", "revealed", "violated", "expired"]).default("pending"),
});

const graph = new StateGraph(PulseState)
  .addNode("reason", reasonNode)
  .addNode("commit", commitNode)
  .addNode("wait", waitNode)
  .addNode("reveal", revealNode)
  .addNode("expire", expireNode)
  .addEdge(START, "reason")
  .addEdge("reason", "commit")
  .addEdge("commit", "wait")
  .addConditionalEdges("wait", routeOnTime, {reveal: "reveal", expire: "expire"})
  .addEdge("reveal", END)
  .addEdge("expire", END)
  .compile();
```

## ERC-7857 iNFT — `pulse_inft_mint` tool

A fifth tool (v1 `tool()` factory) that mints the agent's encrypted state
as an iNFT on 0G Galileo. Same `@pulse/sdk` primitives — no shell-out:

```ts
import {tool} from "langchain";
import {
  encryptStateBlob, buildMintProof, mintINFT,
  bindPulseAgent, recordCommitment, readINFTState,
  INFT_HUMAN_READABLE_ABI
} from "@pulse/sdk";
import {createPublicClient, createWalletClient, http, namehash, defineChain} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import * as z from "zod";

const zgGalileo = defineChain({
  id: 16602,
  name: "0G Galileo Testnet",
  nativeCurrency: {name: "OG", symbol: "OG", decimals: 18},
  rpcUrls: {default: {http: ["https://evmrpc-testnet.0g.ai"]}}
});

const pulseInftMintTool = tool(
  async ({stateBlob, description, commitmentIds = []}) => {
    const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
    const tee = privateKeyToAccount(process.env.DEMO_TEE_SIGNER_KEY as `0x${string}`);
    const inft = process.env.INFT_ADDRESS as `0x${string}`;

    const pub = createPublicClient({chain: zgGalileo, transport: http()});
    const wal = createWalletClient({account: agent, chain: zgGalileo, transport: http()});

    const blob = encryptStateBlob(stateBlob);
    const proof = await buildMintProof(tee, inft, blob.dataHash);
    const mintTx = await mintINFT(wal, {
      inftAddress: inft, proofs: [proof],
      dataDescriptions: [description], to: agent.address
    });
    await pub.waitForTransactionReceipt({hash: mintTx});

    const tokenId = await pub.readContract({
      address: inft, abi: INFT_HUMAN_READABLE_ABI, functionName: "totalSupply"
    }) as bigint;

    await bindPulseAgent(wal, {
      inftAddress: inft, tokenId,
      agentId: BigInt(process.env.AGENT_ID!),
      ensNode: namehash(process.env.AGENT_ENS_NAME!),
      pulse: process.env.PULSE_ADDRESS as `0x${string}`,
      pulseChainId: 11155111n
    });

    for (const cid of commitmentIds) {
      await recordCommitment(wal, {
        inftAddress: inft, tokenId,
        commitmentId: BigInt(cid),
        pulseChainId: 11155111n
      });
    }

    const state = await readINFTState(pub, inft, tokenId);
    return JSON.stringify({
      tokenId: tokenId.toString(),
      dataHash: blob.dataHash,
      sealedKey: blob.keyHex,
      owner: state.owner,
      commitments: state.commitments.length,
      explorer: `https://chainscan-galileo.0g.ai/address/${inft}`
    });
  },
  {
    name: "pulse_inft_mint",
    description:
      "Mint the agent's encrypted state as an ERC-7857 iNFT on 0G Galileo, " +
      "binding ENS, ERC-8004 id, and recent Pulse commitments into one " +
      "transferable NFT. Use when the user wants the agent's identity to " +
      "be ownable / transferable.",
    schema: z.object({
      stateBlob: z.string(),
      description: z.string(),
      commitmentIds: z.array(z.string()).optional()
    })
  }
);
```

Add `pulseInftMintTool` to the tools array passed to `createAgent` — the
agent now has Pulse commit/reveal/status PLUS iNFT mint as first-class
tool calls.

## Notes

- LangChain doesn't strictly need the SKILL.md files at runtime — but
  they're useful as system-prompt prefixes that teach the model when to
  use which tool. Load them with `await fs.readFile`.
- For Python LangChain (`langchain` PyPI), wrap `@pulse/sdk` calls in
  `subprocess` shells or build a thin Python client around viem-py / web3.py.
  The contract ABI lives in `packages/sdk/src/pulse.ts` as `PULSE_ABI`.
