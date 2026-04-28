import { ethers } from "ethers";
import { createClobClient } from "./clients/clob.js";
import { parseCliArgs } from "./config/args.js";
import { Generic15mDipArbStrategy, DipArbConfig } from "./strategies/Generic15mDipArbStrategy.js";
import { Btc5mVolatilityStrategy } from "./strategies/Btc5mVolatilityStrategy.js";
import { Generic15mPairArbStrategy } from "./strategies/Generic15mPairArbStrategy.js";
import { Bot, BotConfig } from "./bot.js";
import { PnlManager } from "./lib/pnlManager.js"; // Import PnlManager
import { Btc5mFixedHedgeStrategy } from "./strategies/Btc5mFixedHedgeStrategy.js";
import { Btc5mDynamicHedgeStrategy } from "./strategies/Btc5mDynamicHedgeStrategy.js";
import { Btc5mWickDriftStrategy } from "./strategies/Btc5mWickDriftStrategy.js";
import { Btc5mNoiseReversionStrategy } from "./strategies/Btc5mNoiseReversionStrategy.js";
import { Btc5mRecursiveDynamicHedgeStrategy } from "./strategies/Btc5mRecursiveDynamicHedgeStrategy.js";
import { Btc15mExtremeMeanReversionStrategy } from "./strategies/Btc15mExtremeMeanReversionStrategy.js";
import { redeemPositions } from "./scripts/redeem.js";
import { SessionLogger } from "./lib/sessionLogger.js";
import dns from 'dns';
import http from 'http';
import https from 'https';

// Fix Cloudflare IPv6 Network Unreachability / Timeouts globally
dns.setDefaultResultOrder('ipv4first');

// Strengthen IPv4 force for Axios/HTTP
http.globalAgent = new http.Agent({ family: 4 });
https.globalAgent = new https.Agent({ family: 4 });
// Suppress Axios/CLOB Client massive JSON error noise
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.includes('[CLOB Client]') || msg.includes('not enough balance') || msg.includes('request error')) {
        if (msg.includes('not enough balance')) {
             originalConsoleError(`\x1b[31m[Strategy Warning]\x1b[0m Insufficient collateral balance.`);
        }
        return;
    }
    originalConsoleError.apply(console, args);
};

const originalConsoleLog = console.log;
console.log = (...args: any[]) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.includes('[CLOB Client]') || msg.includes('request error')) {
        return;
    }
    originalConsoleLog.apply(console, args);
};
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

        // [NEW] Background Balance Sync for Dashboard
        const syncBalance = async () => {
            try {
                // Ethers setup
                const { getUsdcContract, CONFIG, isProxyEnabled } = await import("./clients/config.js");
                const usdc = getUsdcContract();
                const provider = usdc.provider;
                
                // 1. EOA Balance
                let eoaAddr = "";
                let eoaBal = 0;
                try {
                    const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
                    eoaAddr = wallet.address;
                    const res = await usdc.balanceOf(eoaAddr);
                    eoaBal = parseFloat(ethers.utils.formatUnits(res, 6));
                } catch(e){}

                // 2. Proxy Balance
                let proxyBal = 0;
                let proxyAddr = CONFIG.POLY_PROXY_ADDRESS;
                if (isProxyEnabled() && proxyAddr) {
                    try {
                        const res = await usdc.balanceOf(proxyAddr);
                        proxyBal = parseFloat(ethers.utils.formatUnits(res, 6));
                    } catch(e){}
                }

                // 3. Open Positions
                let openPos = 0;
                try {
                    const targetAddr = proxyAddr || eoaAddr;
                    if (targetAddr) {
                        const req = await fetch(`https://data-api.polymarket.com/positions?user=${targetAddr}&limit=100`);
                        const data = await req.json();
                        if (Array.isArray(data)) {
                            for (const pos of data) {
                                const size = parseFloat(pos.size);
                                const price = parseFloat(pos.currentValue || pos.initialValue || "0") / size; // currentValue is total, so we just add it
                                if (pos.currentValue !== undefined) {
                                    openPos += parseFloat(pos.currentValue);
                                } else {
                                    openPos += size * price; 
                                }
                            }
                        }
                    }
                } catch(e){}

                pnlManager.updateDashboardWallets(eoaBal, proxyBal, openPos);
            } catch (e) {}
        };
        syncBalance(); // Initial
        setInterval(syncBalance, 30000); // Every 30s

        setInterval(() => {
            console.clear();
            const allStats = pnlManager.getAllStats();
            const coins = ['BTC', 'ETH', 'XRP', 'SOL'];

            console.log(color(`\n══════════════════════════════════════════════════════════`, COLORS.DIM));
            console.log(color(`📊 POLY-ADDICT TRADING HUD (LIVE)`, COLORS.BRIGHT + COLORS.CYAN));
            console.log(color(`══════════════════════════════════════════════════════════`, COLORS.DIM));

            // Wallet
            console.log(`Wallet:`);
            console.log(`  EOA (Gas):       $${allStats.eoaBalance.toFixed(2)}`);
            if (allStats.proxyBalance > 0 || allStats.eoaBalance === 0) {
                console.log(`  Proxy (Trading): $${allStats.proxyBalance.toFixed(2)}`);
            }
            console.log(`  Open Positions:  $${allStats.openPositionValue.toFixed(2)}`);
            
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
                    const idParts = (c.id || "market").split('-');
                    const shortId = idParts.length > 2 ? idParts.slice(-4).join('-') : c.id;
                    console.log(`  • ${c.coin} ${shortId} [Exp: $${(c.yesCost + c.noCost).toFixed(2)}]`);
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
        console.log("Initializing CLOB client...");
    const clobClient = await createClobClient();

    // 3. Strategy
    console.log(`Initializing strategy (${args.strategy || 'dip'})...`);
    let strategy;

    if (args.strategy === 'true-arb') {
        strategy = new Generic15mPairArbStrategy({
            coin: args.coin,
            maxRiskPct: 0.05, // Default safe configs or map from args if needed
            // Map relevant args or rely on strategy defaults
        });
    } else if (args.strategy === 'btc5m') {
        strategy = new Btc5mVolatilityStrategy(args);
    } else if (args.strategy === 'wick-drift') {
        strategy = new Btc5mWickDriftStrategy(args);
    } else if (args.strategy === 'reversion') {
        strategy = new Btc5mNoiseReversionStrategy({ ...args, tradeSizeUsd: 2 });
    } else if (args.strategy === 'dynamic-hedge') {
        strategy = new Btc5mDynamicHedgeStrategy(args);
    } else if (args.strategy === 'recursive-dynamic') {
        strategy = new Btc5mRecursiveDynamicHedgeStrategy(args);
    } else if (args.strategy === 'simple-hedge') {
        strategy = new Btc5mFixedHedgeStrategy(args);
    } else if (args.strategy === 'usa-session') {
        strategy = new Btc15mExtremeMeanReversionStrategy(args);
    } else {
        strategy = new Generic15mDipArbStrategy(args);
    }
    SessionLogger.init(strategy.name || args.strategy || 'default', args);

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

    const bot = new Bot(clobClient, strategy, config);
    await bot.start();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});