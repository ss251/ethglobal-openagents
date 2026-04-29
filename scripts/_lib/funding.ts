/**
 * Direction-aware token funding + approval. Replaces the buggy
 * ensureFundedAndApproved that only checked TOKEN0 balance and minted blindly.
 *
 * The bug: when an agent committed to *sell* TOKEN1 (pETH) but already had
 * enough TOKEN0 (pUSD), the old guard saw `balance(TOKEN0) > 1` and skipped
 * minting entirely. The swap then reverted with ~30k gas (insufficient
 * balance) because TOKEN1 was empty. Diagnosed live during the un-coached
 * Telegram run where commitment #11 went Pending and could not execute.
 *
 * Fix: only check + fund the token actually being sold. Idempotent: mints
 * the *shortfall*, not a flat 100. Approves the swap router for that token
 * if allowance is below the swap amount.
 */

import {
    type Address,
    type PublicClient,
    type WalletClient,
    parseEther
} from "viem";
import {ERC20_ABI} from "./abi";

const MINT_BUFFER = parseEther("1"); // mint shortfall + 1 token of headroom

export interface PoolTokens {
    token0: Address;
    token1: Address;
    swapRouter: Address;
}

export interface SwapDirection {
    /** true if selling TOKEN0 (zeroForOne); false if selling TOKEN1 */
    zeroForOne: boolean;
    /** absolute amount of input token the swap will take */
    amountIn: bigint;
}

export async function ensureFundedAndApproved(
    publicClient: PublicClient,
    walletClient: WalletClient,
    account: {address: Address},
    pool: PoolTokens,
    swap: SwapDirection,
    log: (msg: string) => void = () => {}
): Promise<{minted: boolean; approved: boolean; balanceBefore: bigint; balanceAfter: bigint}> {
    const inputToken = swap.zeroForOne ? pool.token0 : pool.token1;
    const tokenLabel = swap.zeroForOne ? "TOKEN0" : "TOKEN1";

    const balanceBefore = await publicClient.readContract({
        address: inputToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address]
    });

    let minted = false;
    let balanceAfter = balanceBefore;
    if (balanceBefore < swap.amountIn) {
        const shortfall = swap.amountIn - balanceBefore;
        const mintAmount = shortfall + MINT_BUFFER;
        log(`→ minting ${tokenLabel} (${shortfall} wei short, mint=${mintAmount})`);
        const tx = await walletClient.writeContract({
            account: walletClient.account!,
            chain: walletClient.chain,
            address: inputToken,
            abi: ERC20_ABI,
            functionName: "mint",
            args: [account.address, mintAmount]
        });
        await publicClient.waitForTransactionReceipt({hash: tx});
        balanceAfter = balanceBefore + mintAmount;
        minted = true;
    }

    const allowance = await publicClient.readContract({
        address: inputToken,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, pool.swapRouter]
    });

    let approved = false;
    if (allowance < swap.amountIn) {
        log(`→ approving ${tokenLabel} → SwapTest router`);
        const tx = await walletClient.writeContract({
            account: walletClient.account!,
            chain: walletClient.chain,
            address: inputToken,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [pool.swapRouter, 2n ** 256n - 1n]
        });
        await publicClient.waitForTransactionReceipt({hash: tx});
        approved = true;
    }

    return {minted, approved, balanceBefore, balanceAfter};
}
