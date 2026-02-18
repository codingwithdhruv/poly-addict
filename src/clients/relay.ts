import { createWalletClient, http, Hex, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { CONFIG } from "./config.js";

export function createRelayClient(): RelayClient {
    const account = privateKeyToAccount(CONFIG.PRIVATE_KEY as Hex);

    // Use fallback transport for RPC redundancy
    const transports = CONFIG.RPC_URLS.map(url => http(url));

    const wallet = createWalletClient({
        account,
        chain: polygon,
        transport: fallback(transports)
    });

    // Create a RelayClient for EACH builder cred set
    const clients = CONFIG.BUILDER_CREDS_LIST.map(creds => {
        const builderConfig = new BuilderConfig({
            localBuilderCreds: creds
        });

        return new RelayClient(
            CONFIG.RELAYER_URL,
            CONFIG.CHAIN_ID,
            wallet,
            builderConfig
        );
    });

    if (clients.length === 0) throw new Error("No relay clients created");

    // If only one, return it directly
    if (clients.length === 1) return clients[0];

    // Return Proxy wrapper for rotation
    let currentIndex = 0;

    console.log(`[RelayClient] Initialized with ${clients.length} builder credentials. Active: 0`);

    return new Proxy(clients[0], {
        get(target, prop, receiver) {
            // Get the actual function from the CURRENT client
            const client = clients[currentIndex];
            const value = Reflect.get(client, prop, receiver);

            if (typeof value === 'function') {
                return async (...args: any[]) => {
                    try {
                        return await value.apply(client, args);
                    } catch (error: any) {
                        const msg = error?.message?.toLowerCase() || JSON.stringify(error).toLowerCase();
                        // Check for rate limits or throttling
                        if (msg.includes("limit") || msg.includes("429") || msg.includes("throttled")) {
                            console.warn(`\n[RelayClient] ⚠️ Builder ${currentIndex} rate limited/failed. Switching...`);

                            // Rotate through available clients
                            const originalIndex = currentIndex;
                            let attempt = 0;
                            const maxRetries = clients.length - 1; // Try others

                            while (attempt < maxRetries) {
                                currentIndex = (currentIndex + 1) % clients.length;
                                console.log(`[RelayClient] 🔄 Switched to builder ${currentIndex}`);
                                const nextClient = clients[currentIndex];

                                try {
                                    // Retry with new client
                                    return await (nextClient as any)[prop].apply(nextClient, args);
                                } catch (retryError: any) {
                                    const retryMsg = retryError?.message?.toLowerCase() || JSON.stringify(retryError).toLowerCase();
                                    console.warn(`[RelayClient] ⚠️ Builder ${currentIndex} also failed (${retryMsg})`);

                                    if (retryMsg.includes("limit") || retryMsg.includes("429") || retryMsg.includes("throttled")) {
                                        attempt++;
                                        continue;
                                    }
                                    throw retryError; // Non-rate-limit error on retry, bubble up
                                }
                            }
                            console.error(`[RelayClient] ❌ All builders rate limited or failed.`);
                        }
                        throw error;
                    }
                };
            }
            return value;
        }
    });
}
