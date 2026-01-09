import { DipArbConfig } from "../strategies/dipArb.js";

type CoinType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

interface CliArgs {
    coin: CoinType;
    dipThreshold: number;
    slidingWindowMs: number;
    leg2TimeoutSeconds: number;
    sumTarget: number;
    shares: number;
    windowMinutes: number; // Entry window in minutes
    verbose: boolean;
    info: boolean;
    redeem: boolean;
}

export function parseCliArgs(): DipArbConfig {
    const args = process.argv.slice(2);

    // 1. Parse Coin Type
    let coin: CoinType = 'ETH'; // Default
    if (args.includes('--btc') || args.includes('-b')) coin = 'BTC';
    else if (args.includes('--eth') || args.includes('-e')) coin = 'ETH';
    else if (args.includes('--sol') || args.includes('-s')) coin = 'SOL';
    else if (args.includes('--xrp') || args.includes('-x')) coin = 'XRP';

    // Also check --coin=XYZ
    const coinArg = args.find(a => a.startsWith('--coin='));
    if (coinArg) {
        const val = coinArg.split('=')[1].toUpperCase();
        if (['BTC', 'ETH', 'SOL', 'XRP'].includes(val)) {
            coin = val as CoinType;
        }
    }

    // 2. Define Defaults per Coin
    // Updated presets to match poly-all-in-one code behavior
    // poly-all-in-one uses windowMinutes: 14 (effectively 'always open')
    // Users can override with --entry-window=2 if they want the strict Smart Ape behavior
    const coinDefaults: Record<CoinType, Partial<DipArbConfig>> = {
        BTC: {
            dipThreshold: 0.35,       // 35% relative drop (Safe 2026)
            slidingWindowMs: 4000,    // Moderate smoothing
            leg2TimeoutSeconds: 120,  // Extended wait for rebounds
            sumTarget: 0.97,          // 3% spread (prioritize completion)
            shares: 10,               // Small size to minimize risk
            windowMinutes: 10         // Early entry to avoid late traps
        },
        ETH: {
            dipThreshold: 0.40,       // 40% relative drop
            slidingWindowMs: 4000,
            leg2TimeoutSeconds: 150,  // 2.5 min wait
            sumTarget: 0.96,          // 4% spread
            shares: 8,                // Reduced size
            windowMinutes: 10
        },
        XRP: {
            dipThreshold: 0.50,       // 50% drop (high volatility filter)
            slidingWindowMs: 3000,    // Faster reaction
            leg2TimeoutSeconds: 180,  // 3 min wait for volatile alts
            sumTarget: 0.95,          // 5% spread (thinner liquidity)
            shares: 5,                // Smallest size
            windowMinutes: 8          // Shortest window for safety
        },
        SOL: {
            dipThreshold: 0.40,       // Aligned with ETH safe metrics
            slidingWindowMs: 4000,
            leg2TimeoutSeconds: 150,
            sumTarget: 0.96,
            shares: 8,
            windowMinutes: 10
        },
    };

    const defaults = coinDefaults[coin];

    // 3. Helper to parse args
    const getArgValue = (name: string, defaultVal: number): number => {
        // Check --name=VAL
        const arg = args.find(a => a.startsWith(`--${name}=`));
        if (arg) {
            const val = parseFloat(arg.split('=')[1]);
            return isNaN(val) ? defaultVal : val;
        }
        return defaultVal;
    };

    // Helper for boolean flags
    const getBoolArg = (name: string, defaultVal: boolean): boolean => {
        if (args.includes(`--${name}`)) return true;
        const arg = args.find(a => a.startsWith(`--${name}=`));
        if (arg) {
            return arg.split('=')[1].toLowerCase() === 'true';
        }
        return defaultVal;
    };

    // 4. Construct Final Config
    return {
        coin,
        dipThreshold: getArgValue('dip', defaults.dipThreshold!),
        slidingWindowMs: getArgValue('window', defaults.slidingWindowMs!),
        leg2TimeoutSeconds: getArgValue('timeout', defaults.leg2TimeoutSeconds!),
        sumTarget: getArgValue('target', defaults.sumTarget!),
        shares: getArgValue('shares', defaults.shares!),
        windowMinutes: getArgValue('entry-window', defaults.windowMinutes!), // exposed as --entry-window
        verbose: getBoolArg('verbose', false),
        info: args.includes('-info') || args.includes('--info'),
        redeem: args.includes('-redeem') || args.includes('--redeem')
    };
}
