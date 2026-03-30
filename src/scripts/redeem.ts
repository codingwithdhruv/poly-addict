import { CTFClient } from '../clients/ctf.js';
import { CONFIG } from '../clients/config.js';
import dns from 'dns';

// Fix Cloudflare IPv6 Network Drops
dns.setDefaultResultOrder('ipv4first');

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

// A simple global lock to prevent double execution if the background async task overlaps
let isRedeeming = false;

// ============ Main Redemption Logic ============

export async function redeemPositions(options: { forceEOA?: boolean } = {}) {
    if (isRedeeming) {
        console.log("⏳ Redemption already in progress. Skipping execution.");
        return;
    }
    isRedeeming = true;

    try {
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║           Redeem Positions - Ended Markets               ║');
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log('');

        const ctf = new CTFClient();
        const eoaAddress = ctf.getAddress();
        const proxyAddress = CONFIG.POLY_PROXY_ADDRESS;
        const userAddress = proxyAddress || eoaAddress;
        let isProxy = !!proxyAddress;

        console.log(`EOA:   ${eoaAddress}`);
        if (proxyAddress) {
            console.log(`Proxy: ${proxyAddress}`);
        }

        let useRelayer = false;
        if (isProxy && !options.forceEOA && CONFIG.RELAYER_API_KEY && CONFIG.RELAYER_API_KEY_ADDRESS) {
            console.log("Mode: RELAYER V2 (native gasless transactions)");
            useRelayer = true;
        } else if (isProxy) {
            console.log("Mode: EOA FALLBACK (paying gas, executing via Safe)");
        } else {
            console.log("Mode: EOA DIRECT");
        }

        // Fetch positions
        console.log(`\nFetching ALL positions for ${userAddress}...`);
        let positions: Position[] = [];
        let offset = 0;
        let hasMore = true;

        try {
            while (hasMore) {
                let success = false;
                let retries = 0;
                let data: any[] = [];
                
                while (!success && retries < 3) {
                    try {
                        const response = await fetch(
                            `https://data-api.polymarket.com/positions?user=${userAddress}&limit=100&offset=${offset}`,
                            { signal: (AbortSignal as any).timeout(10000) }
                        );
                        if (!response.ok) throw new Error(`Data API Error: ${response.statusText}`);
                        data = await response.json() as any[];
                        success = true;
                    } catch (e: any) {
                        retries++;
                        if (retries >= 3) throw e;
                        await new Promise(r => setTimeout(r, 1000 * retries));
                    }
                }

                if (success && Array.isArray(data) && data.length > 0) {
                    positions.push(...data.map((p: any) => ({
                        conditionId: p.conditionId,
                        asset: p.asset,
                        outcome: p.outcome,
                        size: parseFloat(p.size),
                        title: p.title,
                        redeemable: p.redeemable
                    })));
                    offset += 100;
                    if (data.length < 100) hasMore = false;
                } else {
                    hasMore = false;
                }
            }
        } catch (e: any) {
            console.error("Failed to fetch positions:", e.message);
            isRedeeming = false;
            return;
        }

        if (positions.length === 0) {
            console.log("No positions found.");
            isRedeeming = false;
            return;
        }

        console.log(`Found ${positions.length} total active positions.`);

        // ============ Process & Analyze Markets ============
        // ============ Process & Analyze Markets ============
        const marketsToProcess: ProcessedMarket[] = [];
        const conditionMap = new Map<string, { title: string, yBal: number, nBal: number }>();

        // 1. Group by Condition ID & Aggregate Balances directly from API sizes
        for (const pos of positions) {
            if (!conditionMap.has(pos.conditionId)) {
                conditionMap.set(pos.conditionId, { title: pos.title, yBal: 0, nBal: 0 });
            }
            const info = conditionMap.get(pos.conditionId)!;
            const outcome = pos.outcome.toLowerCase();
            
            if (outcome === 'yes' || outcome === 'up') {
                info.yBal += pos.size;
            } else if (outcome === 'no' || outcome === 'down') {
                info.nBal += pos.size;
            }
        }

        // 2. Validate against CTF resolution
        for (const [conditionId, info] of conditionMap.entries()) {
            const { title, yBal, nBal } = info;
            
            if (yBal < 0.000001 && nBal < 0.000001) continue;

            try {
                const res = await ctf.getMarketResolution(conditionId);
                
                let mergeAmount = 0;
                let needsRedeem = false;

                if (!res.isResolved) {
                    // Unresolved Market: Can only merge paired arb positions to free USDC.e
                    mergeAmount = Math.min(yBal, nBal);
                    if (mergeAmount < 0.50) mergeAmount = 0; // Dust threshold protection
                } else {
                    // Resolved Market: Never merge, just natively redeem remaining balance
                    needsRedeem = true;
                }

                if (mergeAmount > 0.000001 || needsRedeem) {
                    marketsToProcess.push({
                        conditionId,
                        title,
                        yesTokenId: "", // Obsolete
                        noTokenId: "",  // Obsolete
                        yesBalance: yBal,
                        noBalance: nBal,
                        mergeAmount,
                        needsRedeem,
                        tokenIds: { yesTokenId: "", noTokenId: "" } // Obsolete
                    });
                }
            } catch (e: any) {
                console.warn(`Error checking resolution for ${conditionId}:`, e.message);
            }
        }

        if (marketsToProcess.length === 0) {
            console.log("No actionable positions found (all dust or already cleared).");
            isRedeeming = false;
            return;
        }

        console.log(`\nProcessing ${marketsToProcess.length} actionable markets...`);

        // EXECUTE NATIVE V2 RELAYER
        if (useRelayer) {
            const relayerTransactions: any[] = [];
            
            for (const m of marketsToProcess) {
                if (m.mergeAmount > 0.000001) {
                    relayerTransactions.push(ctf.getMergeTransaction(m.conditionId, m.mergeAmount.toString()));
                }
                if (m.needsRedeem) {
                    relayerTransactions.push(ctf.getRedeemTransaction(m.conditionId));
                }
            }

            if (relayerTransactions.length > 0) {
                console.log(`\n📦 Sending ${relayerTransactions.length} transactions via Relayer V2 (Batched)...`);
                
                // Chunk into batches of 20 to prevent block gas limit issues on Relayer
                const CHUNK_SIZE = 20;
                let allSuccess = true;
                
                for (let i = 0; i < relayerTransactions.length; i += CHUNK_SIZE) {
                    const chunk = relayerTransactions.slice(i, i + CHUNK_SIZE);
                    console.log(`\n🔹 Processing Batch ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} txs)...`);
                    const success = await ctf.executeV2Relayer(chunk);
                    if (!success) {
                        allSuccess = false;
                        console.log("⚠️ Batch submission had failures.");
                        break;
                    }
                }

                if (allSuccess) {
                    console.log("✅ All relayer batches successfully submitted.");
                    isRedeeming = false;
                    return; 
                } else {
                    console.log("⚠️ Relayer submission had failures. Falling back to EOA direct execution...");
                }
            }
        }

        // ============ EOA Fallback / Direct Mode ============
        console.log(`\n🔌 Executing ${marketsToProcess.length} markets via EOA (Direct/Safe)...`);

        for (const m of marketsToProcess) {
            console.log(`Running ${m.title.slice(0, 30)}...`);
            try {
                if (m.mergeAmount > 0.000001) {
                    console.log(`  (Active) Merging ${m.mergeAmount.toFixed(4)} pairs...`);
                    if (isProxy) {
                        console.log(`  ⚠️ Proxy Relayer failed above. Cannot use EOA fallback to call Safe proxy directly. Skipping.`);
                    } else {
                        await ctf.mergePositionsDirect(m.conditionId, m.mergeAmount.toString(), false);
                    }
                }

                if (m.needsRedeem) {
                    console.log(`  (Resolved) Redeeming...`);
                    if (isProxy) {
                        console.log(`  ⚠️ Proxy Relayer failed above. Cannot use EOA fallback to call Safe proxy directly. Skipping.`);
                    } else {
                        await ctf.redeemPositionsDirect(m.conditionId, 'BOTH', false);
                    }
                }
                console.log(`  ✅ Done.`);
            } catch (e: any) {
                console.error(`  ❌ Failed: ${e.message}`);
            }
        }
    } catch (e: any) {
        console.error(`❌ Critical Redeem Error: ${e.message}`);
    } finally {
        isRedeeming = false;
    }
}




// ESM-safe check for direct execution
if (process.argv[1] && (process.argv[1].endsWith('redeem.js') || process.argv[1].endsWith('redeem.ts'))) {
    redeemPositions().catch(console.error);
}
