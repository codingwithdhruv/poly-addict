
import { CTFClient } from '../clients/ctf.js';
import { CONFIG } from '../clients/config.js';
import { createRelayClient } from '../clients/relay.js';

// Define Position Type based on Data API response
interface Position {
    conditionId: string;
    asset: string; // Token ID
    outcome: string;
    size: number;
    title: string;
    redeemable?: boolean;
}

export async function redeemPositions(options: { dryRun?: boolean } = {}) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║           Redeem Positions - Ended Markets               ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const ctf = new CTFClient();

    // Determine address to query: Proxy if set, otherwise EOA
    const eoaAddress = ctf.getAddress();
    const proxyAddress = CONFIG.POLY_PROXY_ADDRESS;
    const userAddress = proxyAddress || eoaAddress;
    const isProxy = !!proxyAddress;

    console.log(`EOA:   ${eoaAddress}`);
    if (proxyAddress) {
        console.log(`Proxy: ${proxyAddress}`);
        console.log(`Using Proxy address for position check.`);
    }

    // Initialize Relayer if using Proxy
    let relayer;
    if (isProxy) {
        console.log("Initializing Relayer for batch execution...");
        try {
            relayer = createRelayClient();
        } catch (e: any) {
            console.warn("Failed to init relayer (missing creds?):", e.message);
        }
    }

    // Fetch positions from Data API
    console.log(`Fetching positions for ${userAddress}...`);
    let positions: Position[] = [];
    try {
        // Use global fetch
        const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&redeemable=true&limit=100`);
        if (!response.ok) {
            throw new Error(`Data API Error: ${response.statusText}`);
        }
        const data = await response.json() as unknown;
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

    console.log(`Found ${positions.length} redeemable positions.`);

    // Group by condition ID
    const positionsByCondition = new Map<string, Position[]>();
    for (const pos of positions) {
        const existing = positionsByCondition.get(pos.conditionId) || [];
        existing.push(pos);
        positionsByCondition.set(pos.conditionId, existing);
    }

    const batchTransactions: any[] = [];
    const processedConditions = new Set<string>();

    for (const [conditionId, posList] of positionsByCondition) {
        if (processedConditions.has(conditionId)) continue;
        processedConditions.add(conditionId);

        // Find token IDs (using robust logic)
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
            const tIds = { yesTokenId, noTokenId };
            const title = posList[0].title;

            console.log(`Processing: ${title.slice(0, 40)}...`);

            try {
                // Check actual balances on chain
                const bals = await ctf.getPositionBalanceByTokenIds(conditionId, tIds, userAddress);
                let yBal = parseFloat(bals.yesBalance);
                let nBal = parseFloat(bals.noBalance);

                console.log(`  TokenIDs: YES=${tIds.yesTokenId.slice(0, 10)}... NO=${tIds.noTokenId.slice(0, 10)}...`);
                console.log(`  Balances: YES=${yBal.toFixed(6)}, NO=${nBal.toFixed(6)}`);

                // 1. Merge (requires on-chain balance)
                const mergeAmt = Math.min(yBal, nBal);
                if (mergeAmt > 0.000001) {
                    console.log(`  -> Merging ${mergeAmt} pairs`);
                    if (isProxy && relayer) {
                        batchTransactions.push(ctf.getMergeTransaction(conditionId, mergeAmt.toString()));
                    } else {
                        await ctf.mergeByTokenIds(conditionId, tIds, mergeAmt.toString(), isProxy);
                    }
                    yBal -= mergeAmt;
                    nBal -= mergeAmt;
                }

                // 2. Redeem/Clear remaining
                // If we have actual balance OR if the Data API insists we have a position (ghost/dust cleanup)
                // We trust the Data API's "redeemable" flag to trigger a cleanup attempt.
                const apiSaysWeHaveSize = posList.some(p => p.size > 0);

                if (yBal > 0.000001 || nBal > 0.000001 || apiSaysWeHaveSize) {
                    let reason = "";
                    if (yBal > 0.000001) reason += "Has YES bal ";
                    if (nBal > 0.000001) reason += "Has NO bal ";
                    if (apiSaysWeHaveSize && yBal <= 0.000001 && nBal <= 0.000001) reason += "API shows size (forced cleanup)";

                    console.log(`  -> Queuing Redeem/Clear (${reason.trim()})`);

                    if (isProxy && relayer) {
                        batchTransactions.push(ctf.getRedeemTransaction(conditionId));
                    } else {
                        // Fallback EOA
                        if (yBal > 0.000001) await ctf.redeemByTokenIds(conditionId, tIds, 'YES', isProxy);
                        if (nBal > 0.000001) await ctf.redeemByTokenIds(conditionId, tIds, 'NO', isProxy);
                        // If EOA and 0 balance but API says yes? We can't really guess outcome to redeem blindly without balance.
                        // But for batch proxy, we use [1, 2] so it's safe.
                    }
                }

            } catch (e: any) {
                console.warn(`  Error processing ${conditionId}: ${e.message}`);
            }
        } else {
            console.warn(`  Skipping: Could not resolve token IDs for ${conditionId}`);
        }
    }

    // EXECUTE BATCH
    if (batchTransactions.length > 0) {
        console.log(`\n📦 Sending Batch of ${batchTransactions.length} transactions via Relayer...`);
        if (relayer) {
            try {
                // Use execute() as per Relayer documentation for batching
                const response = await (relayer as any).execute(batchTransactions, "Batch Redeem/Merge");
                console.log(`✅ Batch Submitted! Tx Hash: ${response.transactionHash || JSON.stringify(response)}`);

                if (response.wait) {
                    await response.wait();
                    console.log("✅ Transaction confirmed.");
                }
            } catch (e: any) {
                console.error("Batch execution failed:", e.message);
            }
        }
    } else {
        console.log("No actions needed.");
    }
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
    redeemPositions().catch(console.error);
}
