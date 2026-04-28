import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { CTFClient } from '../clients/ctf.js';
import { CONFIG } from '../clients/config.js';
import { GammaClient } from '../clients/gamma-api.js';

// Rate limit state file
const RATE_LIMIT_FILE = path.join(process.cwd(), 'data', 'rate_limit_state.json');

interface RateLimitState {
    exhausted: boolean;
    resetsAt: number; // Unix timestamp
}

interface Position {
    conditionId: string;
    asset: string;
    outcome: string;
    size: number;
    title: string;
    redeemable?: boolean;
}

interface MarketToRedeem {
    address: string;
    conditionId: string;
    title: string;
    tokenIds: string[];
    balances: number[];
    outcomeCount: number;
    needsRedeem: boolean;
    mergeAmount: number;
}

// ============ Rate Limit Management ============

function ensureDataDir() {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function loadRateLimitState(): RateLimitState {
    ensureDataDir();
    try {
        if (fs.existsSync(RATE_LIMIT_FILE)) {
            const data = JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf-8'));
            return data;
        }
    } catch (e) { }
    return { exhausted: false, resetsAt: 0 };
}

function saveRateLimitState(state: RateLimitState) {
    ensureDataDir();
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(state, null, 2));
}

function isRelayerAvailable(): boolean {
    const state = loadRateLimitState();
    if (!state.exhausted) return true;

    const now = Date.now();
    if (now >= state.resetsAt) {
        saveRateLimitState({ exhausted: false, resetsAt: 0 });
        console.log("✅ Relayer quota has reset. Switching back to Relayer mode.");
        return true;
    }

    const remainingMins = Math.ceil((state.resetsAt - now) / 60000);
    console.log(`⏳ Relayer quota exhausted. Resets in ${remainingMins} minutes. Using EOA fallback.`);
    return false;
}

function markRelayerExhausted(resetsInSeconds: number) {
    const resetsAt = Date.now() + (resetsInSeconds * 1000);
    saveRateLimitState({ exhausted: true, resetsAt });
    console.log(`⚠️ Relayer quota exhausted. Will reset at ${new Date(resetsAt).toLocaleTimeString()}`);
}

function parseResetTime(errorData: any): number {
    try {
        const errStr = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
        const match = errStr.match(/resets in (\d+) seconds/);
        if (match) return parseInt(match[1]);
    } catch (e) { }
    return 3600; 
}

function isRateLimitError(e: any): boolean {
    const errStr = typeof e === 'string' ? e : JSON.stringify(e);
    return errStr.includes("429") ||
        errStr.includes("quota exceeded") ||
        errStr.includes("Too Many Requests");
}

// ============ Main Redemption Logic ============

export async function redeemPositions(options: { dryRun?: boolean; forceEOA?: boolean } = {}) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║           Redeem Positions - Ended Markets               ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const ctf = new CTFClient();
    const gamma = new GammaClient();
    const eoaAddress = ctf.getAddress();
    const proxyAddress = CONFIG.POLY_PROXY_ADDRESS || "";

    console.log(`\nEOA:   ${eoaAddress}`);
    console.log(`Proxy: ${proxyAddress}`);
    
    // Scan both Proxy (automated) and EOA (manual/older trades)
    const walletsToScan = [proxyAddress, eoaAddress].filter(a => !!a && a !== ethers.constants.AddressZero);
    const allFoundMarkets: MarketToRedeem[] = [];

    // Determine execution mode for Proxy redemptions
    let useRelayer = !!proxyAddress && !options.forceEOA && isRelayerAvailable();

    for (const scanAddress of walletsToScan) {
        const isProxy = scanAddress.toLowerCase() === proxyAddress.toLowerCase();
        console.log(`\n🔍 Checking Wallet: ${isProxy ? "PROXY" : "EOA"} (${scanAddress})...`);
        
        let positions: Position[] = [];
        
        // 1. Data API Discovery (Fast)
        try {
            const [posRes, closedRes] = await Promise.all([
                fetch(`https://data-api.polymarket.com/positions?user=${scanAddress}&limit=500`),
                fetch(`https://data-api.polymarket.com/closed-positions?user=${scanAddress}&limit=500`)
            ]);

            const posData = posRes.ok ? await posRes.json() as any[] : [];
            const closedData = closedRes.ok ? await closedRes.json() as any[] : [];
            const combined = [...(Array.isArray(posData) ? posData : []), ...(Array.isArray(closedData) ? closedData : [])];
            
            positions = combined.map((p: any) => ({
                conditionId: p.conditionId,
                asset: p.asset,
                outcome: p.outcome,
                size: parseFloat(p.size),
                title: p.title,
                redeemable: p.redeemable
            })).filter(p => !!p.conditionId);
            
            console.log(`  [DataAPI] Found ${positions.length} historical positions.`);
        } catch (e: any) {
            console.warn(`  [DataAPI] Failed for ${scanAddress}: ${e.message}`);
        }

        // 2. Blockchain Deep Discovery (50,000 blocks ~ 3 days)
        // This finds tokens even if the Data API doesn't list them as "positions".
        try {
            // Explicitly pass chainId 137 to bypass auto-detection failure in strict RPCs
            const publicProvider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URLS[0] || CONFIG.RPC_URL, 137);
            const historicalIds = await ctf.getHistoricalTokenIds(scanAddress, 50000, publicProvider);
            
            for (const id of historicalIds) {
                if (!positions.some(p => p.asset === id)) {
                    positions.push({
                        conditionId: "unknown",
                        asset: id,
                        outcome: "unknown",
                        size: 0,
                        title: `Discovered ID: ${id.slice(0, 10)}...`,
                        redeemable: true
                    });
                }
            }
        } catch (e: any) {
            console.warn(`  [DeepScan] Failed: ${e.message}`);
        }

        if (positions.length === 0) continue;

        // --- Analyze & Resolve ---
        // Group by condition to handle multi-outcome redemptions properly
        const positionsByCondition = new Map<string, Position[]>();
        for (const pos of positions) {
            const cid = pos.conditionId === "unknown" ? `token:${pos.asset}` : pos.conditionId;
            const existing = positionsByCondition.get(cid) || [];
            existing.push(pos);
            positionsByCondition.set(cid, existing);
        }

        for (const [key, posList] of positionsByCondition) {
            const title = posList[0].title;
            const assetId = posList[0].asset;
            const dataApiCid = key.startsWith("token:") ? "unknown" : key;

            try {
                // TOKEN-PRIME RESOLUTION: Use Asset ID to find the canonical Gamma market
                const canonical = await resolveCanonicalMetadata(gamma, title, dataApiCid, assetId);
                
                let currentConditionId = canonical?.conditionId || dataApiCid;
                let currentTokenIds = canonical?.tokenIds || posList.map(p => p.asset);

                if (!currentConditionId || currentConditionId === "unknown") continue;

                // On-chain balance check for ALL outcomes in the market
                const bals = await ctf.getBalancesByTokenIds(currentConditionId, currentTokenIds, scanAddress);
                const numBalances = bals.balances.map(b => parseFloat(b));
                const totalBalance = numBalances.reduce((a, b) => a + b, 0);

                if (totalBalance < 0.000001) continue;

                // Check resolution and payout availability
                const res = await ctf.getMarketResolution(currentConditionId);
                const isRedeemableApi = posList.some(p => p.redeemable === true);
                
                if (res.isResolved || isRedeemableApi) {
                    console.log(`  • Actionable: ${title.slice(0, 35)}... (Bal: ${totalBalance.toFixed(2)})`);
                    
                    const mergeAmount = currentTokenIds.length > 0 ? Math.min(...numBalances) : 0;
                    const canMerge = mergeAmount >= 0.01;
                    const needsRedeem = numBalances.some(b => b > mergeAmount + 0.0001);

                    if (canMerge || needsRedeem) {
                        allFoundMarkets.push({
                            address: scanAddress,
                            conditionId: currentConditionId,
                            title,
                            tokenIds: currentTokenIds,
                            balances: numBalances,
                            outcomeCount: currentTokenIds.length,
                            needsRedeem,
                            mergeAmount: canMerge ? mergeAmount : 0
                        });
                        console.log(`    -> Queued for ${isProxy ? "Proxy" : "EOA"}`);
                    }
                }
            } catch (e: any) {
                console.warn(`    [Resolve] Mapping failed for ${title}: ${e.message}`);
            }
        }
    }

    if (allFoundMarkets.length === 0) {
        console.log("\n✅ [Success] All positions cleared. No actionable winnings found in either Proxy or EOA.");
        return;
    }

    console.log(`\n🚀 Executing transactions for ${allFoundMarkets.length} markets...`);

    // Prepare separate batches for Relayer (Proxy) and Direct (EOA)
    const relayerTransactions: { to: string; data: string; value: string }[] = [];
    const directTasks: MarketToRedeem[] = [];

    for (const m of allFoundMarkets) {
        const isProxy = m.address.toLowerCase() === proxyAddress.toLowerCase();
        
        if (isProxy && useRelayer) {
            if (m.mergeAmount > 0) relayerTransactions.push(ctf.getMergeTransaction(m.conditionId, m.outcomeCount, m.mergeAmount.toString()));
            if (m.needsRedeem) relayerTransactions.push(ctf.getRedeemTransaction(m.conditionId, m.outcomeCount));
        } else {
            directTasks.push(m);
        }
    }

    // 1. Relayer Execution (Batch)
    if (relayerTransactions.length > 0) {
        console.log(`\n📦 Sending Relayer Batch (${relayerTransactions.length} items)...`);
        try {
            const success = await ctf.executeBuilderBatch(relayerTransactions);
            if (!success) {
                console.warn("⚠️ Relayer batch failed or timed out. Falling back to direct mode for these items.");
                directTasks.push(...allFoundMarkets.filter(m => m.address === proxyAddress));
            }
        } catch (e: any) {
            console.error("❌ Relayer error:", e.message);
            directTasks.push(...allFoundMarkets.filter(m => m.address === proxyAddress));
        }
    }

    // 2. Direct EOA / Proxy-via-Safe Execution (Sequential)
    if (directTasks.length > 0) {
        console.log(`\n🔌 Executing Direct (EOA or Non-Relayer Proxy)...`);
        for (const m of directTasks) {
            const isProxy = m.address.toLowerCase() === proxyAddress.toLowerCase();
            try {
                if (m.mergeAmount > 0) {
                    console.log(`  Merging ${m.title.slice(0, 20)}...`);
                    await ctf.mergeByTokenIds(m.conditionId, m.tokenIds, m.mergeAmount.toString(), isProxy);
                }
                if (m.needsRedeem) {
                    console.log(`  Redeeming ${m.title.slice(0, 20)}...`);
                    await ctf.redeemByTokenIds(m.conditionId, m.tokenIds, isProxy);
                }
                console.log(`  ✅ Done.`);
            } catch (e: any) {
                console.error(`  ❌ Failed ${m.title}: ${e.message}`);
            }
        }
    }
}

/**
 * Robust Canonical Resolver: 
 * Resolves the true CTF metadata by cross-referencing Token IDs (preferred) or Condition IDs.
 */
async function resolveCanonicalMetadata(gamma: GammaClient, title: string, dataApiConditionId: string, assetId?: string): Promise<{ conditionId: string; tokenIds: string[] } | null> {
    try {
        let match: any = null;

        // TOKEN-PRIME Discovery: Search by the exact Asset ID from the Data API
        if (assetId) {
            match = await gamma.getMarketByTokenId(assetId);
        }

        // Fallback Strategy 2: Search by Data API Condition ID
        if (!match && dataApiConditionId !== "unknown") {
            match = await gamma.getMarketMetadata(dataApiConditionId);
        }

        // Fallback Strategy 3: Search by Title
        if (!match) {
            const searchQuery = encodeURIComponent(title.slice(0, 100));
            const markets = await gamma.getMarkets(`search=${searchQuery}`);
            match = markets.find((m: any) => m.question === title) || (markets.length > 0 ? markets[0] : null);
        }
        
        if (match) {
            const conditionId = match.condition_id || match.conditionId;
            let clobTokenIds = match.clob_token_ids || match.clobTokenIds;
            
            if (typeof clobTokenIds === 'string' && clobTokenIds.startsWith('[')) {
                try { clobTokenIds = JSON.parse(clobTokenIds); } catch(e) {}
            }
            
            if (conditionId && Array.isArray(clobTokenIds)) {
                return {
                    conditionId: conditionId,
                    tokenIds: clobTokenIds
                };
            }
        }
    } catch (e: any) {
        console.warn(`[Canonical Resolver] Failed for "${title}":`, e.message);
    }
    return null;
}

// ESM-safe check for direct execution
if (process.argv[1] && (process.argv[1].endsWith('redeem.js') || process.argv[1].endsWith('redeem.ts'))) {
    redeemPositions().catch(console.error);
}