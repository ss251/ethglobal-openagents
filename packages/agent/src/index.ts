import {createWalletClient, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";

interface AgentConfig {
    privateKey: Hex;
    pulseAddress: Address;
    agentId: bigint;
    rpcUrl: string;
    providerSigner: Address;
}

export async function bootstrap(cfg: AgentConfig) {
    const account = privateKeyToAccount(cfg.privateKey);
    const wallet = createWalletClient({account, chain: baseSepolia, transport: http(cfg.rpcUrl)});
    return {wallet, cfg};
}

if (import.meta.url === `file://${process.argv[1]}`) {
    console.log("pulse agent harness — wire context source + sealed inference + scenario in src/scenarios/");
}
