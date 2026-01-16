
import { CTFClient } from '../clients/ctf.js';
import { CONFIG } from '../clients/config.js';
import { createRelayClient } from '../clients/relay.js';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';

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

interface ProcessedMarket {
    conditionId: string;
    title: string;
    yesTokenId: string;
    noTokenId: string;
    yesBalance: number;
    noBalance: number;
    mergeAmount: number;
    needsRedeem: boolean;
    tokenIds: { yesTokenId: string; noTokenId: string };
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
        // Reset expired, relayer should be available
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
    // Extract "resets in X seconds" from error
    try {
        const errStr = typeof errorData === 'string' ? errorData : JSON.stringify(errorData);
        const match = errStr.match(/resets in (\d+) seconds/);
        if (match) return parseInt(match[1]);
    } catch (e) { }
    return 3600; // Default 1 hour if can't parse
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
    const eoaAddress = ctf.getAddress();
    const proxyAddress = CONFIG.POLY_PROXY_ADDRESS;
    const userAddress = proxyAddress || eoaAddress;
    const isProxy = !!proxyAddress;

    console.log(`EOA:   ${eoaAddress}`);
    if (proxyAddress) {
        console.log(`Proxy: ${proxyAddress}`);
    }

    // Determine execution mode
    let useRelayer = isProxy && !options.forceEOA && isRelayerAvailable();
    let relayer: any = null;

    if (useRelayer) {
        console.log("Mode: RELAYER (gasless batched transactions)");
        try {
            relayer = createRelayClient();
        } catch (e: any) {
            console.warn("Failed to init relayer:", e.message);
            console.log("Falling back to EOA mode.");
            useRelayer = false;
        }
    } else if (isProxy) {
        console.log("Mode: EOA FALLBACK (paying gas, executing via Safe)");
    } else {
        console.log("Mode: EOA DIRECT");
    }

    // Fetch positions
    console.log(`\nFetching positions for ${userAddress}...`);
    let positions: Position[] = [];
    try {
        // [FIX] Remove 'redeemable=true' to ensure we fetch LOST trades too (for cleanup)
        const response = await fetch(
            `https://data-api.polymarket.com/positions?user=${userAddress}&limit=100` // Removed &redeemable=true
        );
        if (!response.ok) throw new Error(`Data API Error: ${response.statusText}`);

        const data = await response.json() as any[];
        if (Array.isArray(data)) {
            positions = data.map((p: any) => ({
                conditionId: p.conditionId,
                asset: p.asset,
                outcome: p.outcome,
                size: parseFloat(p.size),
                title: p.title,
                redeemable: p.redeemable
            }));
        }
    } catch (e: any) {
        console.error("Failed to fetch positions:", e.message);
        return;
    }

    if (positions.length === 0) {
        console.log("No redeemable positions found.");
        return;
    }

    console.log(`Found ${positions.length} total positions.`);

    // ============ Process & Analyze Markets ============
    const marketsToProcess: ProcessedMarket[] = [];
    const positionsByCondition = new Map<string, Position[]>();
    for (const pos of positions) {
        const existing = positionsByCondition.get(pos.conditionId) || [];
        existing.push(pos);
        positionsByCondition.set(pos.conditionId, existing);
    }

    for (const [conditionId, posList] of positionsByCondition) {
        const tokenIds = await resolveTokenIds(conditionId, posList);
        if (!tokenIds) {
            console.warn(`  Skipping: Could not resolve token IDs for ${conditionId}`);
            continue;
        }

        const { yesTokenId, noTokenId } = tokenIds;
        const title = posList[0].title;

        try {
            const bals = await ctf.getPositionBalanceByTokenIds(conditionId, { yesTokenId, noTokenId }, userAddress);
            const yBal = parseFloat(bals.yesBalance);
            const nBal = parseFloat(bals.noBalance);

            // Skip if no actual balance (dust check)
            if (yBal < 0.000001 && nBal < 0.000001) {
                // console.log(`  ${title.slice(0, 30)}... - No balance, skipping`);
                continue;
            }

            // [FIX] Filter out Active Markets (Unresolved)
            // Since we fetch ALL positions now, we must ensure we only touch resolved ones.
            const res = await ctf.getMarketResolution(conditionId);
            if (!res.isResolved) {
                // console.log(`  ${title.slice(0, 30)}... - Not resolved, skipping`);
                continue;
            }

            const mergeAmount = Math.min(yBal, nBal);
            // Check if we need to call redeem methods (if remaining balance > dust)
            const remainingYes = yBal - mergeAmount;
            const remainingNo = nBal - mergeAmount;
            const needsRedeem = remainingYes > 0.000001 || remainingNo > 0.000001;

            if (mergeAmount > 0.000001 || needsRedeem) {
                marketsToProcess.push({
                    conditionId,
                    title,
                    yesTokenId,
                    noTokenId,
                    yesBalance: yBal,
                    noBalance: nBal,
                    mergeAmount,
                    needsRedeem,
                    tokenIds: { yesTokenId, noTokenId }
                });
            }

        } catch (e: any) {
            console.warn(`Error checking balance for ${conditionId}:`, e.message);
        }
    }

    if (marketsToProcess.length === 0) {
        console.log("No actionable positions found (all dust or already cleared).");
        return;
    }

    console.log(`\nProcessing ${marketsToProcess.length} markets...`);

    // ============ Execution Logic ============

    // Prepare Batch for Relayer
    const relayerTransactions: any[] = [];

    // Map to store market data for fallback execution
    const fallbackData = new Map<string, ProcessedMarket>();

    for (const m of marketsToProcess) {
        console.log(`• ${m.title.slice(0, 40)}...`);
        let actionStr = "";

        fallbackData.set(m.conditionId, m); // Store for fallback

        if (m.mergeAmount > 0.000001) {
            actionStr += `Merge(${m.mergeAmount.toFixed(2)}) `;
            if (useRelayer) {
                relayerTransactions.push(ctf.getMergeTransaction(m.conditionId, m.mergeAmount.toString()));
            }
        }

        if (m.needsRedeem) {
            actionStr += `Redeem `;
            if (useRelayer) {
                relayerTransactions.push(ctf.getRedeemTransaction(m.conditionId));
            }
        }
        console.log(`  -> Actions: ${actionStr}`);
    }

    // EXECUTE
    if (useRelayer && relayerTransactions.length > 0) {
        console.log(`\n📦 Sending Batch of ${relayerTransactions.length} transactions via Relayer...`);
        try {
            const response = await (relayer as any).execute(relayerTransactions, "Batch Redeem/Merge");
            console.log(`✅ Batch Submitted! Tx Hash: ${response.transactionHash || JSON.stringify(response)}`);
            if (response.wait) {
                await response.wait();
                console.log("✅ Transaction confirmed.");
            }
            return; // Success!

        } catch (e: any) {
            console.error("❌ Relayer Execution Failed:", e.message);

            // Analyze error for Rate Limit
            if (isRateLimitError(e) || (e.data && e.data.error && isRateLimitError(e.data.error))) {
                const errorData = e.data?.error || e.message;
                const resetSeconds = parseResetTime(errorData);
                markRelayerExhausted(resetSeconds);
                console.log("🔄 Switching to EOA Fallback execution...");
            } else {
                console.log("⚠️ Unknown Relayer error. Attempting EOA fallback anyway.");
            }
            // Proceed to Fallback block below
        }
    }

    // ============ EOA Fallback / Direct Mode ============
    // (If not using relayer, or if relayer failed above)
    // We iterate marketsToProcess and execute individually via EOA (Safe or Direct)

    console.log(`\n🔌 Executing ${marketsToProcess.length} markets via EOA (Direct/Safe)...`);

    for (const m of marketsToProcess) {
        console.log(`Running ${m.title.slice(0, 30)}...`);

        try {
            if (m.mergeAmount > 0.000001) {
                console.log(`  Merging ${m.mergeAmount.toFixed(4)}...`);
                // isProxy=true means we call Safe methods via EOA signer
                await ctf.mergeByTokenIds(m.conditionId, m.tokenIds, m.mergeAmount.toString(), isProxy);
            }

            if (m.needsRedeem) {
                console.log(`  Redeeming...`);
                // Redeem BOTH sides (contract handles burning losers / paying winners)
                // This saves us from guessing which side won if API data is stale.
                await ctf.redeemByTokenIds(m.conditionId, m.tokenIds, 'BOTH', isProxy);
            }
            console.log(`  ✅ Done.`);
        } catch (e: any) {
            console.error(`  ❌ Failed: ${e.message}`);
        }
    }
}


// --- Helper: Resolve Token IDs ---
async function resolveTokenIds(conditionId: string, posList: Position[]): Promise<{ yesTokenId: string, noTokenId: string } | null> {
    let yesTokenId: string | undefined;
    let noTokenId: string | undefined;

    function normalize(o: string) {
        const low = o.toLowerCase();
        if (low === 'yes' || low === 'up') return 'YES';
        if (low === 'no' || low === 'down') return 'NO';
        return o;
    }

    // 1. From API position data
    for (const p of posList) {
        const o = normalize(p.outcome);
        if (o === 'YES') yesTokenId = p.asset;
        if (o === 'NO') noTokenId = p.asset;
    }

    // 2. Fallback to Gamma API
    if (!yesTokenId || !noTokenId) {
        try {
            const mktRes = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
            const mktData = await mktRes.json() as any[];
            if (mktData && mktData.length > 0) {
                const mkt = mktData[0];

                if (mkt.clobTokenIds) {
                    let cTokens: string[] = [];
                    try { cTokens = Array.isArray(mkt.clobTokenIds) ? mkt.clobTokenIds : JSON.parse(mkt.clobTokenIds); } catch (e) { }
                    if (cTokens.length === 2) {
                        yesTokenId = cTokens[0];
                        noTokenId = cTokens[1];
                    }
                }

                if ((!yesTokenId || !noTokenId) && mkt.tokens && mkt.tokens.length >= 2) {
                    const tYes = mkt.tokens.find((t: any) => normalize(t.outcome) === 'YES');
                    const tNo = mkt.tokens.find((t: any) => normalize(t.outcome) === 'NO');
                    if (tYes) yesTokenId = tYes.token_id;
                    if (tNo) noTokenId = tNo.token_id;
                }
            }
        } catch (err) { }
    }

    if (yesTokenId && noTokenId) {
        return { yesTokenId, noTokenId };
    }
    return null;
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
    redeemPositions().catch(console.error);
}
