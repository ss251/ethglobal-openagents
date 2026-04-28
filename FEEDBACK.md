# Builder feedback — Uniswap v4 + AI Skills integration

Honest notes from wiring `PulseGatedHook` (a v4 hook gating swaps by Pulse
commitments) onto the Uniswap stack via the official `Uniswap/uniswap-ai`
skills. Where things worked, where I lost time, and what I'd want next.

## What worked

**v4-security-foundations + v4-hook-generator are excellent skills.** The
permission risk matrix made the "only enable `beforeSwap`, never enable
`beforeSwapReturnDelta`" decision automatic. The NoOp attack pattern explainer
is clear enough that a builder unfamiliar with v4 will not accidentally
introduce that vulnerability. Both skills loaded into Claude Code via the
`Uniswap/uniswap-ai` repo and informed concrete code decisions on first read —
e.g., I dropped my custom `onlyPoolManager` modifier when the skill confirmed
OZ's `BaseHook` already enforces it.

**The OpenZeppelin uniswap-hooks repo is the right answer for production
hooks.** Inheriting `BaseHook` from `@openzeppelin/uniswap-hooks/base/BaseHook.sol`
gave me hook-permission validation in the constructor, the `onlyPoolManager`
guard, and clean callback overrides. The fact that Uniswap's official
`v4-hook-generator` skill's decision table indexes against the same hook types
OZ exposes makes the two libraries feel co-designed.

**`HookTest` from `lib/uniswap-hooks/test/utils/HookTest.sol` shortens hook
test setup massively.** Inheriting it gives you `manager`, `swapRouter`,
`modifyLiquidityRouter`, `currency0/1`, and helpers like `initPool` /
`modifyPoolLiquidity` for free. The pattern of casting
`address(uint160(Hooks.BEFORE_SWAP_FLAG))` and `vm.deployCodeTo` to put a hook
at a permission-valid address in tests skipped the CREATE2 mining round-trip
entirely.

## Where I lost time

**`BaseHook` isn't where the security-foundations skill says it is.** The skill
references `v4-periphery/src/base/hooks/BaseHook.sol`, but a fresh
`forge install Uniswap/v4-periphery` doesn't have that path — periphery's
`src/` only contains `PositionManager`, `V4Router`, etc. The actual canonical
location is `v4-periphery/src/utils/BaseHook.sol`, but only inside specific
periphery commits. I ended up routing through `OpenZeppelin/uniswap-hooks` and
its nested periphery for a stable BaseHook. Suggestion: the v4-hook-generator /
v4-security-foundations skills should either (a) reference the OZ library
explicitly, or (b) pin the periphery commit/path that ships BaseHook so a
naïve `forge install Uniswap/v4-periphery` works.

**`HookMiner` is even harder to find.** Searched all of v4-core and v4-periphery
top-level for `HookMiner.sol` and got nothing. Eventually located it at
`lib/uniswap-hooks/lib/v4-periphery/src/utils/HookMiner.sol` — only because I
had OZ uniswap-hooks's nested periphery installed. From a clean
`forge install Uniswap/v4-periphery`, you cannot import HookMiner. Suggestion:
either ship it in the published v4-periphery `main` branch, or move it to a
canonical `@uniswap/hook-miner` package that doesn't carry the rest of
periphery as transitive weight.

**Two v4-core versions in the same project break compilation.** I initially
had both `lib/v4-core` (top-level, older commit `e50237c4`) and
`lib/uniswap-hooks/lib/v4-core` (nested, newer commit `d153b048`). The newer
one moved `SwapParams` and `ModifyLiquidityParams` from `IPoolManager` into a
new `src/types/PoolOperation.sol`. uniswap-hooks's BaseHook imports the new
path; my older top-level remap pointed `@uniswap/v4-core/` at the older one;
result: `error: file PoolOperation.sol not found`. Resolution was to drop the
top-level v4-core / v4-periphery / solmate / openzeppelin-contracts entirely
and remap everything through `lib/uniswap-hooks/lib/...`. Suggestion: the
`v4-hook-generator` skill should either warn about this mixed-version footgun
or explicitly recommend "consume v4 transitively through OpenZeppelin
uniswap-hooks if you want a hook." Today the skill assumes top-level v4-core
and v4-periphery are sufficient.

**`HookTest`'s relative imports leak into downstream lint.** When I inherit
`HookTest` from `lib/uniswap-hooks/test/utils/HookTest.sol`, my project's
`forge build` lint phase complains:

    error: file src/interfaces/IHookEvents.sol not found
    error: file test/utils/interfaces/IPoolManagerEvents.sol not found

These imports are relative paths inside uniswap-hooks's own tree. They resolve
fine inside that repo's lint config but fail when the file is consumed from
outside. Compilation succeeds; lint emits errors that the CI script will
likely fail on. Suggestion: change those imports to use the same
`@openzeppelin/uniswap-hooks/...` remapping the source code uses, so they
resolve identically inside and outside the repo.

**Solc version friction.** v4-core requires `0.8.26` and `evm_version =
cancun`. My existing Pulse contract was on `^0.8.20`. The hook-generator skill
mentions `^0.8.24` in its template, which is a third version. Settled on
`0.8.26` to match v4-core. Suggestion: skill templates should pin the same
version v4-core uses, since downstream projects that adopt the template will
need to compile against v4-core anyway.

**`PoolKey key` field collision in tests.** v4-core's `Deployers` declares
`PoolKey key` as a public field. If a test contract inheriting `HookTest`
declares its own `PoolKey internal key`, solc errors with "Identifier already
declared." Easy once you know — but the first compile error gave no hint that
the field was inherited. Suggestion: rename `key` in `Deployers` to
`defaultPoolKey` or document the collision in the v4-hook-generator skill's
test scaffolding section.

**The "sender vs principal" guidance in v4-security-foundations is right but
needed real-world reinforcement.** The skill says clearly that `sender` in
hook callbacks is the router, not the user. In our case, the swap originator
is unknowable from `sender` because v4 swaps go through routers. We instead
identify the principal via the commitment record stored in Pulse, looked up by
`commitmentId` in `hookData`. Worth a worked example in the skill — "if you
need user identity, do not use sender; use a side-channel like an off-chain
commitment registry keyed by an id passed in hookData."

## What I wish existed

**A canonical `@uniswap/v4-periphery` npm or forge package whose `main`
includes `BaseHook` and `HookMiner` at stable paths.** Today the recommended
path is "use OpenZeppelin uniswap-hooks transitively," which works but feels
like a workaround.

**A v4-hook-template skill or starter kit** that scaffolds the foundry
project, remappings, and a hello-world hook with one command. I rebuilt the
foundry.toml + remappings.txt + minimal hook + HookTest harness from scratch.
The skill references the OpenZeppelin Contracts Wizard MCP for code generation
but doesn't generate the surrounding scaffolding. A `forge init` analog —
maybe `npx skills add Uniswap/uniswap-ai && npx uniswap-hook-init` — would
remove ~30 minutes of yak-shaving.

**A small note in the v4-hook-generator skill about hookData encoding
conventions.** Most hooks I read consume hookData as a single struct. For our
case (multi-field hookData carrying `(commitmentId, nonce)`), I wanted to
confirm the bytes layout matched between viem's `encodeAbiParameters` and
Solidity's `abi.decode`. They do, but it required separate verification. A
quick sentence in the skill about "hookData is opaque bytes; both sides agree
on the abi.encode shape" would save a builder ten minutes.

## Trading API

I did not exercise the Trading API or Universal Router in this build — the
flagship use case is hook-gated swaps that any caller submits directly to the
PoolManager. If we later layer on a smart-routing experience, the
`swap-integration` skill is the next thing I'd consult.

## Net

The skill ecosystem moved this from "scary new contract layer I'd have to
audit by hand" to "decision tree I executed in under a day." That's the
strongest endorsement I can give. The friction above is mostly about the
distance between the skill's stable-state reference points (BaseHook,
HookMiner, v4-periphery's `main`) and the actual on-disk reality after a
fresh `forge install`. Closing that gap would make the v4 hook lane
significantly more accessible.
