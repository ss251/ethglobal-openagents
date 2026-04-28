# Python integration (web3.py / eth-account)

Pulse is chain-agnostic on the contract side. The TypeScript SDK is the
default but a Python client is straightforward — Pulse only needs ABI calls
and EIP-191 signature handling.

## Dependencies

```bash
pip install web3 eth-account
```

## ABI

The canonical ABI lives in `packages/sdk/src/pulse.ts` as `PULSE_ABI`. For
Python, drop the Solidity compiler output (`out/Pulse.sol/Pulse.json`) into
a `pulse_abi.py` and load:

```python
import json

with open("pulse_abi.json") as f:
    PULSE_ABI = json.load(f)["abi"]
```

## Commit

```python
from web3 import Web3
from eth_account import Account
from eth_utils import keccak
from eth_abi.packed import encode_packed

w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = Account.from_key(AGENT_PRIVATE_KEY)
pulse = w3.eth.contract(address=PULSE_ADDRESS, abi=PULSE_ABI)

def intent_hash(nonce: bytes, action_data: bytes) -> bytes:
    return keccak(encode_packed(["bytes32", "bytes"], [nonce, action_data]))

def commit(agent_id, action_data, nonce, reasoning_cid, execute_after,
           reveal_window, signer_provider, sealed_sig):
    h = intent_hash(nonce, action_data)
    tx = pulse.functions.commit(
        agent_id, h, reasoning_cid, execute_after, reveal_window,
        signer_provider, sealed_sig
    ).build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 500000,
        "gasPrice": w3.eth.gas_price,
    })
    signed = account.sign_transaction(tx)
    return w3.eth.send_raw_transaction(signed.rawTransaction).hex()
```

## Reveal

```python
def reveal(commitment_id, nonce, action_data):
    tx = pulse.functions.reveal(commitment_id, nonce, action_data).build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 200000,
        "gasPrice": w3.eth.gas_price,
    })
    signed = account.sign_transaction(tx)
    return w3.eth.send_raw_transaction(signed.rawTransaction).hex()
```

## Status check

```python
def get_status(commitment_id) -> int:
    return pulse.functions.getStatus(commitment_id).call()

def get_commitment(commitment_id):
    return pulse.functions.getCommitment(commitment_id).call()
```

## Sealed inference (0G)

```python
import requests

def fetch_sealed_reasoning(broker_url, chat_id, model, signer_address):
    r = requests.get(f"{broker_url}/v1/proxy/signature/{chat_id}",
                     params={"model": model})
    r.raise_for_status()
    data = r.json()
    return {
        "text": data["text"],
        "signature": data["signature"],
        "signer_address": signer_address,
        "chat_id": chat_id,
    }

def verify_sealed(reasoning):
    msg = encode_defunct(text=reasoning["text"])
    recovered = Account.recover_message(msg, signature=reasoning["signature"])
    return recovered.lower() == reasoning["signer_address"].lower()
```

## LangChain Python tools

Same shape as the TS LangChain integration — wrap each function in a
`StructuredTool.from_function(...)`. The SKILL.md prose feeds the agent's
system prompt. Match the JSON schemas to the Solidity types:

- `agentId` → string-encoded uint256
- `actionData`, `nonce`, `reasoningCID` → hex strings
- `executeAfter`, `revealWindow` → string-encoded uint64

Any framework that can drive web3.py works the same way: SmolAgents, the
OpenAI Python SDK with the new tool API, custom loops, or research agents.
