import { Bot } from "./bot.js";
import { DipArbStrategy } from "./strategies/dipArb.js";
import { parseCliArgs } from "./config/args.js";
import { createClobClient } from "./clients/clob.js";
import { createRelayClient } from "./clients/relay.js";
import { AssetType } from "@polymarket/clob-client";
import { redeemPositions } from "./scripts/redeem.js";

async function main() {
    const config = parseCliArgs();

    // INFO MODE: Check Balance & Allowance
    if (config.info) {
        console.log("Initializing CLOB Client for Info...");
        const client = await createClobClient();

        console.log("Fetching Balance & Allowance...");
        try {
            const res = await client.getBalanceAllowance({
                asset_type: AssetType.COLLATERAL
            });
            console.log("DEBUG RES:", JSON.stringify(res));
            // Fetch Native POL (MATIC) Balance
            let polBalance = "0.00";
            if (client.signer && client.signer.provider) {
                const bal = await client.signer.getBalance();
                polBalance = (parseFloat(bal.toString()) / 1e18).toFixed(4);
            }

            console.log("\n========================================");
            console.log(" 💰 ACCOUNT INFO");
            console.log("========================================");

            // Proxy Address
            const proxy = process.env.POLY_PROXY_ADDRESS;
            if (proxy) {
                console.log(` Proxy Address: ${proxy}`);
            } else {
                console.log(` Proxy Address: (Not Set)`);
            }

            // EOA Address
            if (client.signer) {
                const address = await client.signer.getAddress();
                console.log(` EOA Address:   ${address}`);
            }

            console.log(`----------------------------------------`);
            console.log(` POL Balance:   ${polBalance} POL`);
            console.log(` USDC.e Bal:    $${(parseFloat(res.balance) / 1e6).toFixed(2)}`);

            // Parse allowances map (max of all spenders)
            const allowances = (res as any).allowances ? Object.values((res as any).allowances).map((a: any) => parseFloat(a)) : [];
            const maxAllowance = allowances.length > 0 ? Math.max(...allowances) : 0;
            console.log(` USDC.e Allow:  $${(maxAllowance / 1e6).toFixed(2)}`);
            console.log("========================================\n");
        } catch (e: any) {
            console.error("Failed to fetch info:", e.message);
        }
        process.exit(0);
    }

    // REDEEM MODE: Check for and redeem winning positions
    if (config.redeem) {
        await redeemPositions();
        process.exit(0);
    }

    console.log(`Starting Dip Arbitrage Bot for ${config.coin}...`);
    console.log(`Config: Dip=${(config.dipThreshold * 100).toFixed(0)}% Target=${config.sumTarget}`);

    const strategy = new DipArbStrategy(config);
    const bot = new Bot(strategy);
    await bot.start();
}

main();