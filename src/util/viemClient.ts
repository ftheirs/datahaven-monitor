// viem-based EVM client setup for DataHaven networks.
// - Reads ACCOUNT_PRIVATE_KEY from process.env (to be provided via GitHub Secrets in CI).
// - Uses chain/RPC information from the NetworkConfig definitions in src/sanity/config.ts.

import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { NetworkConfig } from "../sanity/config";

export interface ViemClients {
  readonly chain: ReturnType<typeof defineChain>;
  readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly walletClient: ReturnType<typeof createWalletClient>;
  readonly publicClient: ReturnType<typeof createPublicClient>;
}

function getRequiredPrivateKey(): `0x${string}` {
  const raw = process.env.ACCOUNT_PRIVATE_KEY;

  if (!raw || raw.trim() === "") {
    throw new Error("ACCOUNT_PRIVATE_KEY is not set. Provide it via environment (e.g. GitHub secret).");
  }

  // Ensure the key is 0x-prefixed for viem.
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  return normalized as `0x${string}`;
}

export function createViemClients(network: NetworkConfig): ViemClients {
  const pk = getRequiredPrivateKey();
  const account = privateKeyToAccount(pk);

  const chain = defineChain({
    id: network.chain.id,
    name: network.chain.name,
    nativeCurrency: {
      name: network.chain.nativeCurrency.name,
      symbol: network.chain.nativeCurrency.symbol,
      decimals: network.chain.nativeCurrency.decimals,
    },
    rpcUrls: {
      default: {
        http: [network.chain.evmRpcHttpUrl],
      },
    },
  });

  const transport = http(network.chain.evmRpcHttpUrl);

  const walletClient = createWalletClient({
    chain,
    account,
    transport,
  });

  const publicClient = createPublicClient({
    chain,
    transport,
  });

  return {
    chain,
    account,
    walletClient,
    publicClient,
  };
}


