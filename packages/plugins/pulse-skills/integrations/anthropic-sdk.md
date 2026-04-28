# Anthropic API / Claude Agent SDK integration

Plain Anthropic API agents get Pulse via tool-use messages. Same pattern
applies to the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and
custom Anthropic-API loops.

## Tool definitions

```ts
import Anthropic from "@anthropic-ai/sdk";

const tools: Anthropic.Tool[] = [
  {
    name: "pulse_commit",
    description: "Bind agent to a hashed action plus sealed reasoning. Use when the agent has finalized a decision that should not change between now and executeAfter — typically Uniswap v4 swap intents but also transfers, votes, signed signals.",
    input_schema: {
      type: "object",
      properties: {
        agentId: {type: "string"},
        actionDataHex: {type: "string", description: "abi.encode(...) of the action — for v4 swaps, abi.encode(PoolKey, SwapParams)"},
        nonceHex: {type: "string", pattern: "^0x[0-9a-fA-F]{64}$"},
        reasoningCIDHex: {type: "string", pattern: "^0x[0-9a-fA-F]{64}$"},
        executeAfterUnix: {type: "string"},
        revealWindowSeconds: {type: "string"},
        zgChatId: {type: "string"}
      },
      required: ["agentId", "actionDataHex", "nonceHex", "reasoningCIDHex", "executeAfterUnix", "revealWindowSeconds", "zgChatId"]
    }
  },
  {
    name: "pulse_reveal",
    description: "Reveal matching nonce+actionData inside [executeAfter, revealDeadline). Mismatch → Violated, slash reputation.",
    input_schema: {
      type: "object",
      properties: {
        commitmentId: {type: "string"},
        nonceHex: {type: "string"},
        actionDataHex: {type: "string"}
      },
      required: ["commitmentId", "nonceHex", "actionDataHex"]
    }
  },
  {
    name: "pulse_status",
    description: "Read commitment status (Pending/Revealed/Violated/Expired). Use before reveal/swap.",
    input_schema: {
      type: "object",
      properties: {commitmentId: {type: "string"}},
      required: ["commitmentId"]
    }
  }
];
```

## System prompt: include the SKILL.md content

```ts
import {readFileSync} from "node:fs";

const skillsDir = "packages/plugins/pulse-skills/skills";
const skillContent = [
  readFileSync(`${skillsDir}/pulse-commit/SKILL.md`, "utf8"),
  readFileSync(`${skillsDir}/pulse-reveal/SKILL.md`, "utf8"),
  readFileSync(`${skillsDir}/pulse-status-check/SKILL.md`, "utf8"),
  readFileSync(`${skillsDir}/pulse-gated-swap/SKILL.md`, "utf8"),
  readFileSync(`${skillsDir}/sealed-inference-with-pulse/SKILL.md`, "utf8")
].join("\n\n---\n\n");

const system = [
  "You are an autonomous agent that uses Pulse for binding pre-commitments.",
  "When making a decision that should not change once made, call pulse_commit.",
  "Skill references:",
  skillContent
].join("\n\n");
```

The `description` field in each tool definition is the trigger surface; the
SKILL.md content in the system prompt teaches *how* to use the tools (which
fields, what nonce length, what error semantics).

## Tool-use loop

```ts
const client = new Anthropic();

async function runAgent(userMessage: string) {
  let messages: Anthropic.MessageParam[] = [{role: "user", content: userMessage}];

  while (true) {
    const r = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      system,
      tools,
      messages
    });

    messages.push({role: "assistant", content: r.content});

    if (r.stop_reason !== "tool_use") return r;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of r.content) {
      if (block.type !== "tool_use") continue;
      const result = await dispatchPulse(block.name, block.input);
      toolResults.push({type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result)});
    }

    messages.push({role: "user", content: toolResults});
  }
}
```

## Claude Agent SDK shortcut

If you're using `@anthropic-ai/claude-agent-sdk`, you can register the
plugin directory directly — it auto-loads SKILL.md files from
`.claude/skills/` matching the metadata format. Either:

1. Symlink: `ln -s packages/plugins/pulse-skills/skills .claude/skills/pulse`
2. Copy: `cp -r packages/plugins/pulse-skills/skills/* .claude/skills/`

The SDK then surfaces them as auto-loaded skills the model can invoke
without explicit Tool wiring.

## Composability with other Anthropic-skill bundles

Pulse skills don't conflict with Uniswap's `uniswap-ai` skill set or the 0G
skill set. A typical agent loads:

- `uniswap-ai/v4-hook-generator` — for hook authoring (one-time)
- `uniswap-ai/v4-security-foundations` — for hook authoring (one-time)
- `0g-compute-skills/0g-compute` — for sealed inference
- `pulse-skills/*` — for binding decisions

These are layered, not exclusive.
