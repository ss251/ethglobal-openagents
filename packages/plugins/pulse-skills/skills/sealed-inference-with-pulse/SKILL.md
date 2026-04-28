---
name: sealed-inference-with-pulse
description: 'Pull TEE-signed reasoning from 0G Compute (or any EIP-191 personal_sign-compatible provider) and bind it to a Pulse commitment. Use when an autonomous agent must prove that the reasoning behind its onchain decision came from a sealed model run that cannot be retroactively rewritten.'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch
license: MIT
metadata:
  author: pulse
  version: '0.2.0'
---

# sealed-inference-with-pulse

Bind an agent's *reasoning* to its onchain commitment. The provider's TEE
signs the canonical Pulse commit payload using EIP-191 `personal_sign`. The
contract verifies via OpenZeppelin `SignatureChecker.isValidSignatureNow`,
which handles both EOA and ERC-1271 signers. Once a commitment is in, the
reasoning hash cannot be rewritten without invalidating the signature.

## When to use this skill

- The agent's downstream action will be reviewed for honesty — auditors,
  counterparties, governance — and the reasoning needs to be tamper-evident.
- The agent runs in a context where prompt injection or operator pressure is
  a credible threat. TEE attestation makes "the agent's reasoning was X"
  cryptographically verifiable rather than trust-me-bro.
- You want to publish the reasoning *later* (post-reveal) to preserve
  strategy privacy — the `reasoningCID` resolves off-chain and can stay
  private until the agent chooses to disclose.

## How TEE signature verification works

The 0G provider returns:

```json
{
  "text": "<the model's full reasoning text>",
  "signature": "0x<65-byte secp256k1 signature>"
}
```

The signature is over the EIP-191 personal-sign hash:
`keccak256("\x19Ethereum Signed Message:\n" + len(text) + text)`.

Pulse expects you to bind that signed text to a *commit payload hash*:
`keccak256(abi.encode(agentId, intentHash, reasoningCID, executeAfter))`. The
contract recovers the signer via `SignatureChecker` and checks it equals the
`signerProvider` you pass to `commit`. If the model later "changes its mind",
the new reasoning produces a different `text` → different signature → reject.

This is exactly the same path 0G's `processResponse` uses — `ethers.recoverAddress(ethers.hashMessage(message), signature)`.
The chain side calls OZ `MessageHashUtils.toEthSignedMessageHash` then
`ECDSA.recover`. They produce identical results for any 65-byte secp256k1
signature.

## Steps

### 1. Acknowledge the provider's signing address

The first time the agent uses a 0G service it must ack the provider's TEE
signer address. The broker exposes this via the `acknowledgeProviderSigner`
method on the inference service contract. Persist the address on disk —
you'll pass it as `signerProvider` on every commit.

```ts
const signerAddress = await broker.acknowledgeProviderSigner(serviceUrl);
// store in env / KV / file: ZG_SIGNER_ADDRESS
```

### 2. Run inference

Use 0G Compute (or your provider) the way you normally would. The output is
the model's reasoning text, plus a chatId you'll need for signature
retrieval.

```ts
const {chatId, response} = await zgCompute.chat({
  model: "deepseek-reasoner",
  messages: [{role: "user", content: "should agent X sell ETH given..."}]
});
```

### 3. Pull the matching signature

The broker stores the TEE signature keyed by `(chatId, model)`. Fetch it
through `@pulse/sdk`'s helper:

```ts
import {fetchSealedReasoning} from "@pulse/sdk";

const reasoning = await fetchSealedReasoning({
  brokerUrl: process.env.ZG_BROKER_URL!,
  chatId,
  model: "deepseek-reasoner",
  signerAddress: process.env.ZG_SIGNER_ADDRESS! as `0x${string}`
});

// reasoning = { text, signature, signerAddress, chatId }
```

### 4. Verify locally before paying gas

```ts
import {verifySealedReasoning} from "@pulse/sdk";

const ok = await verifySealedReasoning(reasoning);
if (!ok) throw new Error("TEE signature did not verify against expected signer");
```

If this fails, you got the wrong signer address (most common — `signerAddress`
must match the *acked* one), the broker returned a stale signature, or the
provider isn't really a TEE. Don't proceed.

### 5. (Optional) Publish reasoning to content-addressed storage

You commit a `reasoningCID` — a `bytes32`. Pick a scheme:

- **0G Storage**: upload `reasoning.text` (or a JSON wrapper with metadata),
  use the returned CID hash as `reasoningCID`.
- **IPFS / Arweave**: upload, hash the CID into a `bytes32` form. Whatever
  scheme makes the off-chain resolution path verifiable later.
- **Private-until-reveal**: store the text encrypted, publish the
  decryption key only after `revealDeadline` if you want the reasoning to be
  retroactively auditable but not predictively front-runnable.

The Pulse contract treats `reasoningCID` as opaque bytes — it only enforces
that the same value enters the signed payload.

### 6. Bind to commit

The reasoning's signature is now an input to `pulse-commit`. The signer
address is the address you acked in step 1; the signature came from the
broker in step 3.

```ts
import {commitIntent} from "@pulse/sdk";

const tx = await commitIntent(wallet, PULSE_ADDRESS, {
  agentId,
  actionData: encodeSwapAction(poolKey, swapParams),
  nonce,
  reasoning,                  // {text, signature, signerAddress, chatId}
  reasoningCID,               // bytes32 from step 5
  executeAfter,
  revealWindow
});
```

Internally the SDK builds `intentHash` from `(nonce, actionData)` and the
contract validates `sealedSig` over the canonical payload. If anything in
`(agentId, intentHash, reasoningCID, executeAfter)` is off, `commit`
reverts.

## Non-0G providers

Pulse only checks signature validity. Anyone whose private key signs the
EIP-191 payload over `(agentId, intentHash, reasoningCID, executeAfter)`
can be the `signerProvider`. Use this when:

- The agent runs on a different TEE provider (Phala, Marlin, custom Intel
  TDX deployment).
- The agent uses an HSM or threshold signer for the same role.
- During development, when you want a plain EOA to stand in for a TEE
  while end-to-end flows get wired up.

In all cases the trust statement "the model produced this text" is *policy*,
not protocol. Pulse only enforces "this signer signed this hash."

## Failure modes

- **Wrong `signerAddress`** → `verifySealedReasoning` returns `false`.
  Re-acknowledge the provider; the broker may have rotated keys.
- **Whitespace drift in `text`** → signature verifies against a different
  hash than the one you reproduced. Trim consistently or hash the raw bytes
  the broker returned.
- **`SignatureChecker` reverts on commit** → the address you passed as
  `signerProvider` isn't an EOA *and* isn't an ERC-1271 contract. Check the
  type before passing.

## Related skills

- `pulse-commit` — direct downstream consumer of this skill's output.
- `pulse-reveal` — closes the commitment that this skill helped open.
- `pulse-status-check` — for verifying that a commit landed before the
  reveal step.
- 0G's `0g-compute` skill (in `0g-compute-skills`) — covers the
  inference-call mechanics in more depth than this skill needs to.
