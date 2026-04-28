# SPEC: Galaxy-Brain-Resistant Agent Commitment Standard (Pulse)

**Status**: Draft, v0.1
**Date**: 2026-04-28

## Abstract

A standard for autonomous AI agents to make cryptographically binding pre-commitments onchain. An agent commits to a hashed action paired with sealed-inference reasoning at time T. Between T+executeAfter and T+revealDeadline, the agent must reveal an action whose hash matches the commitment, otherwise the commitment is marked violated or expired and the agent's onchain reputation is penalized via ERC-8004.

## Motivation

Autonomous agents act 24/7 without per-decision human oversight. They are vulnerable to:

- Mid-flight prompt injection altering decisions
- MEV searchers / whales that can game agent reaction
- Social engineering that makes the operator pressure the agent post-decision
- Rationalization drift — model "changes its mind" based on selectively-presented late information

Existing patterns (commit-reveal schemes, time-locks like OpenZeppelin's TimelockController, EIP-7715 session keys) address adjacent problems but none combine commit-reveal + time-lock + sealed-inference reasoning + onchain reputation in a single agent-aware primitive.

## Specification

A conforming `Pulse` contract MUST expose:

```solidity
enum Status { Pending, Revealed, Violated, Expired }

struct Commitment {
    uint256 agentId;
    address principal;
    uint64 commitTime;
    uint64 executeAfter;
    uint64 revealDeadline;
    Status status;
    bytes32 intentHash;
    bytes32 reasoningCID;
    address signerProvider;
}

function commit(
    uint256 agentId,
    bytes32 intentHash,
    bytes32 reasoningCID,
    uint64 executeAfter,
    uint64 revealWindow,
    address signerProvider,
    bytes calldata sealedSig
) external returns (uint256 id);

function reveal(uint256 id, bytes32 nonce, bytes calldata actionData) external returns (bool kept);

function markExpired(uint256 id) external;

function getStatus(uint256 id) external view returns (Status);

event Committed(uint256 indexed id, uint256 indexed agentId, bytes32 intentHash, bytes32 reasoningCID, uint64 executeAfter, uint64 revealDeadline, address signerProvider);
event Revealed(uint256 indexed id, uint256 indexed agentId, bytes actionData);
event Violated(uint256 indexed id, uint256 indexed agentId, bytes32 computedHash);
event Expired(uint256 indexed id, uint256 indexed agentId);
```

### Commit semantics

`intentHash = keccak256(abi.encodePacked(nonce, actionData))`. The `actionData` encoding is application-specific and out of scope.

`sealedSig` MUST be an EIP-191 `personal_sign` signature over `keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter))`, signed by the `signerProvider` address. Implementations using 0G Compute MUST use the address acknowledged via `acknowledgeProviderSigner`.

`commit` MUST revert if:
- `msg.sender` is not authorized for `agentId` per ERC-8004 IdentityRegistry
- `sealedSig` does not recover to `signerProvider`

### Reveal semantics

`reveal` MUST be callable only when `block.timestamp >= executeAfter && block.timestamp < revealDeadline`. Outside this window the call MUST revert with `TooEarly` or `TooLate`.

If `keccak256(abi.encodePacked(nonce, actionData)) != intentHash`, the status MUST transition to `Violated` and MUST NOT execute the action. If equal, status transitions to `Revealed`.

### Reputation hooks

Conforming implementations MUST call ERC-8004 ReputationRegistry's `giveFeedback` on every status transition out of `Pending`, with `tag1 = "pulse"` and `tag2` ∈ {"kept", "violated", "expired"}. Implementations MUST NOT revert if the reputation call reverts (use try/catch).

## Rationale

- **Commit-reveal over commit-execute**: keeping the actionData off-chain at commit time prevents adversaries from front-running based on revealed intent. The action only becomes public at reveal.
- **Time-lock window with deadline**: prevents an agent from indefinitely delaying or sniping based on the perfect future moment to reveal — establishes a finite reveal window.
- **Sealed reasoning bound to commit**: the agent's TEE-attested reasoning is bound to the commitment hash, so the reasoning cannot be rewritten retroactively.
- **Reputation-gated penalty**: makes the cost of breaking a commitment economically meaningful long-term. Without this hook the system is theater.
- **Off-chain action execution**: conforming `Pulse` implementations validate the reveal but leave actual execution (the swap, the transfer, the vote) to the agent's downstream code. This keeps the standard minimal and composable.

## Security considerations

- Replay protection: principals MUST use unique nonces per commitment.
- Sealed reasoning visibility: the `reasoningCID` resolves to off-chain (e.g., 0G Storage) reasoning; the principal decides whether to make it public at commit time or only at reveal. Late publication preserves strategy privacy.
- Reveal-window length: too short risks accidental expiration; too long creates a window where the agent can re-evaluate based on new information. Implementations SHOULD support per-commit configurable `revealWindow` and document recommended ranges.
- Front-running on reveal: the moment `actionData` enters the public mempool it can be observed. Mitigation: use private mempools (Flashbots) or sequencer-private channels for the reveal transaction.

## Backwards compatibility

This standard is greenfield; it does not conflict with EIP-7715, EIP-7710, or ERC-4337 session keys. It SHOULD be deployable alongside those mechanisms.

## Reference implementation

`Pulse.sol` in this repository.
