import { ClobClient } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";
import { CONFIG } from "./config.js";

import { providers } from "ethers";

export async function createClobClient(): Promise<ClobClient> {
    // Use FallbackProvider for multiple RPCs
    const providersList = CONFIG.RPC_URLS.map(url => new providers.JsonRpcProvider(url));
    const provider = new providers.FallbackProvider(providersList, 1); // Quorum 1

    const signer = new Wallet(CONFIG.PRIVATE_KEY, provider);
    const chainId = CONFIG.CHAIN_ID || 137;

    console.log(`[ClobClient] Initializing for address: ${signer.address}`);

    // same logic as poly-all-in-one: Init with L1 to get creds, then L2
    const tempClient = new ClobClient({ host: CONFIG.HOST, chain: chainId, signer });
    let apiCreds;

    try {
        apiCreds = await tempClient.deriveApiKey();
        console.log("Derived existing CLOB API Key.");
    } catch (e) {
        console.log("Derive failed, creating new key...");
        apiCreds = await tempClient.createApiKey();
        console.log("Created new CLOB API Key.");
    }

    // Check if proxy is configured
    const proxyAddress = CONFIG.POLY_PROXY_ADDRESS;

    if (proxyAddress) {
        console.log(`[ClobClient] Using Proxy Address: ${proxyAddress} (SignatureType=2)`);
        // Gnosis Safe / Proxy Usage
        return new ClobClient({
            host: CONFIG.HOST,
            chain: chainId,
            signer,
            creds: apiCreds,
            signatureType: 2, // SignatureType.GnosisSafe
            funderAddress: proxyAddress,
            builderConfig: { builderCode: CONFIG.POLY_BUILDER_CODE }
        });
    }

    // Standard EOA Usage
    return new ClobClient({
        host: CONFIG.HOST,
        chain: chainId,
        signer,
        creds: apiCreds,
        builderConfig: { builderCode: CONFIG.POLY_BUILDER_CODE }
    });
}
