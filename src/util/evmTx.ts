import type { PublicClient } from "viem";
import type { EvmWriteOptions } from "@storagehub-sdk/core";

/**
 * Build EIP-1559 gas options based on the latest block base fee.
 *
 * Defaults are tuned for StorageHub txs that can be heavier than a simple ERC20 transfer.
 * - gas: 1,500,000
 * - maxPriorityFeePerGas: 1.5 gwei
 * - maxFeePerGas: baseFee * 2 + priority
 */
export async function buildGasTxOpts(
  publicClient: PublicClient,
): Promise<EvmWriteOptions> {
  const gas = BigInt("1500000");

  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  const baseFeePerGas = latestBlock.baseFeePerGas;
  if (baseFeePerGas == null) {
    throw new Error(
      "This RPC did not return `baseFeePerGas` for the latest block. Cannot build EIP-1559 fees.",
    );
  }

  const maxPriorityFeePerGas = BigInt("1500000000"); // 1.5 gwei
  const maxFeePerGas = baseFeePerGas * BigInt(2) + maxPriorityFeePerGas;

  return { gas, maxFeePerGas, maxPriorityFeePerGas };
}

