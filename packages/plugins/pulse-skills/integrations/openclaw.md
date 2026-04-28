# OpenClaw integration

OpenClaw skills are markdown SKILL files plus an underlying TypeScript handler.
Pulse skills slot in directly: each `SKILL.md` here describes the agent-side
flow, and the handler imports `@pulse/sdk` for the actual chain calls.

## Install

```bash
# from anywhere a CLAUDE.md / AGENTS.md project lives
npx skills add thescoho/ethglobal-openagents
```

This pulls the entire skill bundle into `.claude/skills/` (or `.openclaw/skills/`,
or wherever your runner reads from). The skills work agent-agnostic, so an
OpenClaw-flavored runner reads the same SKILL.md as a Claude Code runner.

## Handler shape

Below is a minimal OpenClaw skill that wraps `pulse-commit`. Drop it in
`packages/agent/src/skills/pulse-commit-handler.ts` of your OpenClaw project:

```ts
import {createWalletClient, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {commitIntent, intentHashForSwap, fetchSealedReasoning} from "@pulse/sdk";

export async function handlePulseCommit(input: {
  agentId: bigint;
  poolKey: any; // your typed PoolKey
  swapParams: any; // your typed SwapParams
  nonce: `0x${string}`;
  reasoningCID: `0x${string}`;
  executeAfter: bigint;
  revealWindow: bigint;
  zgBrokerUrl: string;
  zgChatId: string;
  zgModel: string;
  zgSignerAddress: `0x${string}`;
}) {
  const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.RPC_URL!)
  });

  const reasoning = await fetchSealedReasoning({
    brokerUrl: input.zgBrokerUrl,
    chatId: input.zgChatId,
    model: input.zgModel,
    signerAddress: input.zgSignerAddress
  });

  return commitIntent(wallet, process.env.PULSE_ADDRESS as `0x${string}`, {
    agentId: input.agentId,
    actionData: "0x", // recomputed inside commitIntent — pass real bytes if you prefer
    nonce: input.nonce,
    reasoning,
    reasoningCID: input.reasoningCID,
    executeAfter: input.executeAfter,
    revealWindow: input.revealWindow
  });
}
```

OpenClaw's progressive-disclosure model is friendly to this — only the
SKILL.md gets loaded into context until the agent decides to invoke; the
handler runs out-of-context.

## Tool registration (if your agent runtime uses JSON-Schema tools)

```json
{
  "name": "pulse_commit",
  "description": "Make a Pulse commitment binding the agent to a hashed action plus sealed reasoning. Reveal must happen in [executeAfter, executeAfter+revealWindow).",
  "input_schema": {
    "type": "object",
    "properties": {
      "agentId": {"type": "string", "description": "ERC-8004 IdentityRegistry token id (decimal string)"},
      "poolKey": {"type": "object"},
      "swapParams": {"type": "object"},
      "nonce": {"type": "string", "pattern": "^0x[0-9a-fA-F]{64}$"},
      "reasoningCID": {"type": "string", "pattern": "^0x[0-9a-fA-F]{64}$"},
      "executeAfter": {"type": "string", "description": "unix seconds"},
      "revealWindow": {"type": "string", "description": "seconds"}
    },
    "required": ["agentId", "poolKey", "swapParams", "nonce", "reasoningCID", "executeAfter", "revealWindow"]
  }
}
```

The agent calls `pulse_commit`; OpenClaw routes to the handler above. The
SKILL.md tells the agent *when* to call it (decision-with-non-trivial-reversal,
external-trust-required, etc).
