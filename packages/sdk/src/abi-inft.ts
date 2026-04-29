/**
 * Hand-rolled JSON ABI for PulseAgentINFT — viem's parseAbi can't represent
 * the `tuple[]` return shape of `commitmentsOf` cleanly, so we keep this as
 * the canonical SDK-side ABI. Mirrors `contracts/inft/PulseAgentINFT.sol`.
 */

export const INFT_ABI = [
    {
        type: "function",
        name: "mint",
        stateMutability: "payable",
        inputs: [
            {name: "proofs", type: "bytes[]"},
            {name: "dataDescriptions", type: "string[]"},
            {name: "to", type: "address"}
        ],
        outputs: [{name: "tokenId", type: "uint256"}]
    },
    {
        type: "function",
        name: "bindPulseAgent",
        stateMutability: "nonpayable",
        inputs: [
            {name: "tokenId", type: "uint256"},
            {name: "agentId", type: "uint256"},
            {name: "ensNode", type: "bytes32"},
            {name: "pulse", type: "address"},
            {name: "pulseChainId", type: "uint256"}
        ],
        outputs: []
    },
    {
        type: "function",
        name: "recordCommitment",
        stateMutability: "nonpayable",
        inputs: [
            {name: "tokenId", type: "uint256"},
            {name: "commitmentId", type: "uint256"},
            {name: "pulseChainId", type: "uint256"}
        ],
        outputs: []
    },
    {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
            {name: "to", type: "address"},
            {name: "tokenId", type: "uint256"},
            {name: "proofs", type: "bytes[]"}
        ],
        outputs: []
    },
    {
        type: "function",
        name: "clone",
        stateMutability: "nonpayable",
        inputs: [
            {name: "to", type: "address"},
            {name: "tokenId", type: "uint256"},
            {name: "proofs", type: "bytes[]"}
        ],
        outputs: [{name: "newTokenId", type: "uint256"}]
    },
    {
        type: "function",
        name: "ownerOf",
        stateMutability: "view",
        inputs: [{name: "tokenId", type: "uint256"}],
        outputs: [{type: "address"}]
    },
    {
        type: "function",
        name: "dataHashesOf",
        stateMutability: "view",
        inputs: [{name: "tokenId", type: "uint256"}],
        outputs: [{type: "bytes32[]"}]
    },
    {
        type: "function",
        name: "dataDescriptionsOf",
        stateMutability: "view",
        inputs: [{name: "tokenId", type: "uint256"}],
        outputs: [{type: "string[]"}]
    },
    {
        type: "function",
        name: "tokenURI",
        stateMutability: "view",
        inputs: [{name: "tokenId", type: "uint256"}],
        outputs: [{type: "string"}]
    },
    {
        type: "function",
        name: "pulseBinding",
        stateMutability: "view",
        inputs: [{name: "tokenId", type: "uint256"}],
        outputs: [
            {name: "agentId", type: "uint256"},
            {name: "ensNode", type: "bytes32"},
            {name: "pulse", type: "address"},
            {name: "pulseChainId", type: "uint256"}
        ]
    },
    {
        type: "function",
        name: "commitmentsOf",
        stateMutability: "view",
        inputs: [{name: "tokenId", type: "uint256"}],
        outputs: [
            {
                type: "tuple[]",
                components: [
                    {name: "commitmentId", type: "uint256"},
                    {name: "pulseChainId", type: "uint256"},
                    {name: "recordedAt", type: "uint64"}
                ]
            }
        ]
    },
    {
        type: "function",
        name: "signerProvider",
        stateMutability: "view",
        inputs: [],
        outputs: [{type: "address"}]
    },
    {
        type: "function",
        name: "totalSupply",
        stateMutability: "view",
        inputs: [],
        outputs: [{type: "uint256"}]
    },
    {
        type: "event",
        name: "Minted",
        inputs: [
            {name: "tokenId", type: "uint256", indexed: true},
            {name: "creator", type: "address", indexed: true},
            {name: "owner", type: "address", indexed: true},
            {name: "dataHashes", type: "bytes32[]", indexed: false},
            {name: "dataDescriptions", type: "string[]", indexed: false}
        ]
    },
    {
        type: "event",
        name: "PulseBound",
        inputs: [
            {name: "tokenId", type: "uint256", indexed: true},
            {name: "agentId", type: "uint256", indexed: true},
            {name: "ensNode", type: "bytes32", indexed: false},
            {name: "pulse", type: "address", indexed: false},
            {name: "pulseChainId", type: "uint256", indexed: false}
        ]
    },
    {
        type: "event",
        name: "CommitmentRecorded",
        inputs: [
            {name: "tokenId", type: "uint256", indexed: true},
            {name: "commitmentId", type: "uint256", indexed: true},
            {name: "pulseChainId", type: "uint256", indexed: false},
            {name: "totalCommitments", type: "uint256", indexed: false}
        ]
    }
] as const;
