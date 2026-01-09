import { createClobClient } from "./clients/clob.js";
import { createRelayClient } from "./clients/relay.js";
import { Strategy } from "./strategies/types.js";

export class Bot {
    private strategy: Strategy;

    constructor(strategy: Strategy) {
        this.strategy = strategy;
    }

    async start() {
        try {
            console.log("Starting Bot...");

            console.log("Initializing local wallet and relay client...");
            const relayClient = createRelayClient();

            console.log("Initializing CLOB client...");
            const clobClient = await createClobClient();

            console.log("Initializing strategy...");
            await this.strategy.init(clobClient, relayClient);

            console.log("Running strategy...");
            await this.strategy.run();

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                console.log("\nStopping bot...");
                await this.strategy.cleanup();
                process.exit(0);
            });

        } catch (error) {
            console.error("Fatal error starting bot:", error);
            process.exit(1);
        }
    }
}
