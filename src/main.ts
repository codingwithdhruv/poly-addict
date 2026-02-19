import { ethers } from "ethers";
import { createClobClient } from "./clients/clob.js";
import { createRelayClient } from "./clients/relay.js";
import { parseCliArgs } from "./config/args.js";
import { DipArbStrategy, DipArbConfig } from "./strategies/dipArb.js";
import { Btc5mStrategy } from "./strategies/Btc5mStrategy.js";
import { TruePairArbStrategy } from "./strategies/TruePairArbStrategy.js";
import { Bot, BotConfig } from "./bot.js";
import { PnlManager } from "./lib/pnlManager.js"; // Import PnlManager
import { SimpleHedgeStrategy } from "./strategies/SimpleHedgeStrategy.js";
import { MeanReversionStrategy } from "./strategies/MeanReversionStrategy.js";
import { redeemPositions } from "./scripts/redeem.js";

// --- UI Helpers for Dashboard ---
const COLORS = {
    RESET: "\x1b[0m",
    BRIGHT: "\x1b[1m",
    DIM: "\x1b[2m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    MAGENTA: "\x1b[35m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
};

function color(text: string, colorCode: string): string {
    return `${colorCode}${text}${COLORS.RESET}`;
}

async function main() {
    console.log("🚀 NEW CODE DEPLOYED", Date.now());
    const args = parseCliArgs();

    // --- STANDALONE DASHBOARD MODE ---
    if (args.dashboard) {
        console.clear();
        console.log("Starting Standalone PnL Dashboard...");
        const pnlManager = new PnlManager();

        setInterval(() => {
            console.clear();
            const allStats = pnlManager.getAllStats();
            const coins = ['BTC', 'ETH', 'XRP'];

            console.log(color(`\n══════════════════════════════════════════════════════════`, COLORS.DIM));
            console.log(color(`📊 POLYMARKET DIP ARB DASHBOARD (LIVE)`, COLORS.BRIGHT + COLORS.CYAN));
            console.log(color(`══════════════════════════════════════════════════════════`, COLORS.DIM));

            // Wallet
            console.log(`Wallet:`);
            console.log(`  Balance:        $${allStats.walletBalance.toFixed(2)}`);
            let totalPnL = 0;
            Object.values(allStats.coins).forEach(c => totalPnL += c.realizedPnL);
            const pnlColor = totalPnL >= 0 ? COLORS.GREEN : COLORS.RED;
            console.log(`  Net PnL (Session): ${color((totalPnL >= 0 ? "+" : "") + "$" + totalPnL.toFixed(2), pnlColor)}`);
            console.log(`  Last Update:    ${new Date(allStats.lastUpdate).toLocaleTimeString()}`);
            console.log("");

            // Per Coin Stats
            coins.forEach(c => {
                const s = allStats.coins[c];
                if (s) {
                    const coinPnlColor = s.realizedPnL >= 0 ? COLORS.GREEN : COLORS.RED;
                    // Check if Active Cycle exists for this coin
                    let activeExp = 0;
                    let activeCount = 0;
                    Object.values(allStats.activeCycles).forEach(cycle => {
                        if (cycle.coin === c && cycle.status === 'OPEN') {
                            activeExp += (cycle.yesCost + cycle.noCost);
                            activeCount++;
                        }
                    });

                    const status = activeCount > 0 ? color("ACTIVE", COLORS.GREEN) : "WATCHING";

                    console.log(`${c}:`);
                    console.log(`  Cycles:   ${s.cyclesCompleted} | Wins: ${s.cyclesWon} | Fails: ${s.cyclesLost + s.cyclesAbandoned}`);
                    console.log(`  PnL:      ${color((s.realizedPnL >= 0 ? "+" : "") + "$" + s.realizedPnL.toFixed(2), coinPnlColor)}`);
                    console.log(`  Exposure: $${activeExp.toFixed(2)}`);
                    console.log(`  Status:   ${status}`);
                    console.log("");
                } else {
                    console.log(`${c}: ${color("No Data", COLORS.DIM)}\n`);
                }
            });

            console.log(color(`══════════════════════════════════════════════════════════`, COLORS.DIM));
            console.log(color(`[Active Cycles]`, COLORS.YELLOW));
            if (Object.keys(allStats.activeCycles).length === 0) {
                console.log(color("  No active cycles.", COLORS.DIM));
            } else {
                Object.values(allStats.activeCycles).forEach(c => {
                    console.log(`  • ${c.coin} ${c.id.split('-').slice(-4).join('-')} [Exp: $${(c.yesCost + c.noCost).toFixed(2)}]`);
                });
            }

        }, 1000); // 1s refresh

        // Prevent exit
        return;
    }

    // --- NORMAL BOT MODE ---
    console.log(`Starting Dip Arbitrage Bot for ${args.coin}...`);
    console.log(`Config: Dip=${args.dipThreshold * 100}% Target=${args.sumTarget}`);

    // ... (rest of bot init) ...
    // NOTE: We need to reconstruct the Bot Init logic since we overwrote the file. 
    // I will include the previous logic here.

    // 1. Env Check
    // 1. Env Check handled by config module import


    // Await user confirmation if not verbose? No, just run.
    console.log("Starting Bot...");

    // 2. Clients
    // 2. Clients
    console.log("Initializing local wallet and relay client...");
    // const wallet = new ethers.Wallet(privateKey); // Not needed here if clients handle it
    // const chainId = 137; // Polygon
    const relayClient = createRelayClient();

    console.log("Initializing CLOB client...");
    const clobClient = await createClobClient();

    // 3. Strategy
    console.log(`Initializing strategy (${args.strategy || 'dip'})...`);
    let strategy;

    if (args.strategy === 'true-arb') {
        strategy = new TruePairArbStrategy({
            coin: args.coin,
            maxRiskPct: 0.05, // Default safe configs or map from args if needed
            // Map relevant args or rely on strategy defaults
        });
    } else if (args.strategy === 'btc5m') {
        strategy = new Btc5mStrategy(args);
    } else if (args.strategy === 'simple-hedge') {
        strategy = new SimpleHedgeStrategy(args);
    } else if (args.strategy === 'mean-reversion') {
        strategy = new MeanReversionStrategy(args);
    } else {
        strategy = new DipArbStrategy(args);
    }

    // 4. Bot
    const config: BotConfig = {
        scanIntervalMs: 2000,
        logIntervalMs: 5000
    };

    // Handle --redeem special mode
    if (args.redeem) {
        await redeemPositions();
        return;
    }

    const bot = new Bot(clobClient, relayClient, strategy, config);
    await bot.start();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});