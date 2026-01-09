import { createWalletClient, http, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { CONFIG } from "./config.js";

export function createRelayClient(): RelayClient {
    const account = privateKeyToAccount(CONFIG.PRIVATE_KEY as Hex);
    const wallet = createWalletClient({
        account,
        chain: polygon,
        transport: http(CONFIG.RPC_URL)
    });

    const builderConfig = new BuilderConfig({
        localBuilderCreds: {
            key: CONFIG.POLY_BUILDER_API_KEY,
            secret: CONFIG.POLY_BUILDER_SECRET,
            passphrase: CONFIG.POLY_BUILDER_PASSPHRASE
        }
    });

    return new RelayClient(
        CONFIG.RELAYER_URL,
        CONFIG.CHAIN_ID,
        wallet,
        builderConfig
    );
}
