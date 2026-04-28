# pulse-skills — agent guidance

This plugin gives any AI agent the ability to use Pulse — galaxy-brain-resistant
onchain commitments. The bundle is framework-agnostic. The same SKILL.md files
work whether the agent is running in Claude Code, OpenClaw, Hermes, ElizaOS,
LangChain, or a custom Anthropic-API loop.

## When to use which skill

| Situation                                                                | Skill                          |
| ------------------------------------------------------------------------ | ------------------------------ |
| Agent has decided on a future action and you want it to stick            | `pulse-commit`                 |
| Pending commitment's window opened; the agent needs to fulfil it         | `pulse-reveal`                 |
| Need to read state before deciding what to do next                       | `pulse-status-check`           |
| Action is a Uniswap v4 swap and you want execution gated by Pulse        | `pulse-gated-swap`             |
| Need TEE-signed reasoning for the commit payload                         | `sealed-inference-with-pulse`  |

## Reading order for new contributors

1. The repo's [SPEC.md](../../../SPEC.md) — the standard.
2. [pulse-commit/SKILL.md](./skills/pulse-commit/SKILL.md) — the entry point.
3. [pulse-reveal/SKILL.md](./skills/pulse-reveal/SKILL.md).
4. [pulse-gated-swap/SKILL.md](./skills/pulse-gated-swap/SKILL.md) for the
   v4 enforcement layer.
5. The framework integration that matches your runtime, in `./integrations/`.

## Composing with other skill bundles

Pulse layers cleanly with:

- `Uniswap/uniswap-ai` (`v4-hook-generator`, `v4-security-foundations`,
  `swap-integration`, etc.) — useful when authoring or auditing a custom
  hook that wraps Pulse.
- `0g-compute-skills` — direct upstream for `sealed-inference-with-pulse`.
- `austintgriffith/ethskills` and `pashov/skills` — general Solidity and
  EVM tooling.

No conflicts. All these are markdown-only progressive-disclosure bundles
that get loaded based on the model's needs.

## Versioning

Plugin version follows the parent SPEC version (`0.2.x` for SPEC v0.2).
Patch bumps for SKILL.md edits, minor for new skills, major for breaking
schema changes.
