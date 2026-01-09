
import { createClobClient } from "./src/clients/clob.js";
import { createRelayClient } from "./src/clients/relay.js";

async function probe() {
    console.log("Probing clients...");
    const clobClient = await createClobClient();
    console.log("ClobClient methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(clobClient)));

    // Relay client might also have info
    try {
        const relayClient = createRelayClient();
        console.log("RelayClient methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(relayClient)));

        // Try getting expected safe
        const owner = await clobClient.signer.getAddress();
        try {
            // @ts-ignore
            const safe = await relayClient.getExpectedSafe(owner);
            console.log("Expected Safe Address:", safe);
        } catch (e) {
            console.log("getExpectedSafe failed:", e.message);
        }

    } catch (e) {
        console.log("RelayClient init failed:", e.message);
    }
}

probe();
