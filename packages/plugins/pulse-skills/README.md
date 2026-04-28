# pulse-skills

Drop-in skills bundle that lets **any** AI agent — OpenClaw, Hermes,
ElizaOS / Eliza, LangChain (TS or Python), bare Anthropic-API loops, custom
runners — make galaxy-brain-resistant onchain commitments via [Pulse](../../README.md).

## Why a skills bundle

Pulse has two pieces of value:

1. **The contracts** (`Pulse.sol` + `PulseGatedHook.sol`) — they live onchain
   once, and any agent can hit them.
2. **The agent-side know-how** — when to commit, how to bind sealed reasoning,
   how to drive the v4 hook, what windows are sane, what failure modes to
   guard against.

The contracts are framework-agnostic. The know-how was *not* — until this
bundle. Each skill in this folder is an agent-agnostic SKILL.md that any
runner with a skills loader can install via:

```bash
npx skills add thescoho/ethglobal-openagents
```

Or via the Claude Code marketplace:

```bash
/plugin install pulse-skills@thescoho/ethglobal-openagents
```

## Skills

| Skill                          | What it does                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [pulse-commit](./skills/pulse-commit/SKILL.md)             | Lock the agent into a hashed action + sealed reasoning at time T.                          |
| [pulse-reveal](./skills/pulse-reveal/SKILL.md)             | Close the commitment by submitting matching nonce + actionData inside the window.          |
| [pulse-status-check](./skills/pulse-status-check/SKILL.md) | Read commitment state cheaply before reveal/swap/expire.                                   |
| [pulse-gated-swap](./skills/pulse-gated-swap/SKILL.md)     | Execute a Uniswap v4 swap *through* a Pulse commitment — wrong intent → swap reverts.      |
| [sealed-inference-with-pulse](./skills/sealed-inference-with-pulse/SKILL.md) | Pull TEE-signed reasoning from 0G Compute (or any EIP-191 signer) and bind it to commit.   |

The skills compose. A typical autonomous-agent flow is:

```
sealed-inference-with-pulse  →  pulse-commit  →  pulse-status-check  →  pulse-gated-swap
                                                                  ↘  pulse-reveal (non-swap path)
```

## Framework integrations

Ready-to-paste adapter recipes for popular agent frameworks:

- [OpenClaw](./integrations/openclaw.md)
- [Hermes](./integrations/hermes.md)
- [ElizaOS / Eliza](./integrations/elizaos.md)
- [LangChain / LangGraph](./integrations/langchain.md)
- [Anthropic API + Claude Agent SDK](./integrations/anthropic-sdk.md)
- [Python (web3.py)](./integrations/python.md)

If your framework isn't listed: every skill ships a TypeScript/viem path via
`@pulse/sdk` and a raw-ABI path via `Pulse.sol`. Anything that can call those
two interfaces gets Pulse.

## Agent-agnostic by design

These skills follow the same agent-agnostic ruleset as
`Uniswap/uniswap-ai`:

- Standard markdown + YAML frontmatter — no Claude-specific syntax in the
  skill bodies.
- AGENTS.md symlinks to CLAUDE.md so non-Claude runners see the same
  guidance.
- All examples use widely-deployed libraries (viem, web3.py, eth-account).
- No required vendor SDK beyond `@pulse/sdk` itself, which is a thin
  viem wrapper.

## License

MIT.
