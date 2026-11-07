import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DataApiClient, type PolymarketPosition } from "../clients/data-api.js";
import { createClobClient } from "../clients/clob.js";
import { CONFIG, requirePrivateKey } from "../clients/config.js";

type RedeemOptions = {
    dryRun?: boolean;
    forceEOA?: boolean;
};

type MarketActions = {
    title: string;
    redeem: boolean;
    merge: boolean;
};

/** Redeem resolved positions and merge complementary positions through the maintained SDK. */
export async function redeemPositions(options: RedeemOptions = {}): Promise<void> {
    const eoaAddress = privateKeyToAccount(requirePrivateKey() as `0x${string}`).address;
    const proxyAddress = normalizeAddress(CONFIG.POLY_PROXY_ADDRESS);
    const addresses = options.forceEOA || !proxyAddress
        ? [eoaAddress]
        : [...new Set([proxyAddress, eoaAddress])];
    const dataApi = new DataApiClient();
    let actionCount = 0;

    console.log("\nPolymarket position maintenance");
    for (const address of addresses) {
        const walletName = address.toLowerCase() === proxyAddress?.toLowerCase() ? "proxy" : "EOA";
        console.log(`\nChecking ${walletName} wallet ${address}…`);
        let positions: PolymarketPosition[];
        try {
            positions = await dataApi.listPositions(address, {
                status: "OPEN",
                includeArchived: true,
                filterAmount: 0,
                pageSize: 500,
            });
        } catch (error) {
            console.error(`Could not load positions for ${address}: ${messageOf(error)}`);
            continue;
        }

        const actions = collectActions(positions);
        console.log(`Found ${positions.length} positions and ${actions.size} markets with maintenance actions.`);
        if (actions.size === 0) continue;

        let client: Awaited<ReturnType<typeof createClobClient>> | undefined;
        for (const [conditionId, market] of actions) {
            if (market.merge) {
                actionCount++;
                if (options.dryRun) {
                    console.log(`[dry run] Merge complementary positions: ${market.title} (${conditionId})`);
                } else {
                    try {
                        client ??= await createClobClient(address);
                        const result = await client.mergePositions(conditionId);
                        console.log(`Merged ${market.title}; transaction ${result.transactionHash ?? result.transactionId ?? "submitted"}.`);
                    } catch (error) {
                        console.error(`Merge failed for ${market.title}: ${messageOf(error)}`);
                    }
                }
            }
            if (market.redeem) {
                actionCount++;
                if (options.dryRun) {
                    console.log(`[dry run] Redeem resolved positions: ${market.title} (${conditionId})`);
                } else {
                    try {
                        client ??= await createClobClient(address);
                        const result = await client.redeemPositions(conditionId);
                        console.log(`Redeemed ${market.title}; transaction ${result.transactionHash ?? result.transactionId ?? "submitted"}.`);
                    } catch (error) {
                        console.error(`Redemption failed for ${market.title}: ${messageOf(error)}`);
                    }
                }
            }
        }
    }

    if (actionCount === 0) console.log("\nNo redeemable or mergeable positions found.");
    else if (options.dryRun) console.log(`\nDry run complete: ${actionCount} actions found; nothing was submitted.`);
}

function collectActions(positions: PolymarketPosition[]): Map<string, MarketActions> {
    const actions = new Map<string, MarketActions>();
    for (const position of positions) {
        const conditionId = position.condition_id;
        if (!/^0x[0-9a-f]{64}$/i.test(conditionId) || position.current_size <= 0) continue;
        if (!position.redeemable && !position.mergeable) continue;
        const action = actions.get(conditionId) ?? {
            title: position.title || conditionId,
            redeem: false,
            merge: false,
        };
        action.redeem ||= position.redeemable;
        action.merge ||= position.mergeable;
        actions.set(conditionId, action);
    }
    return actions;
}

function normalizeAddress(address: string): string | undefined {
    if (!address) return undefined;
    try {
        return getAddress(address);
    } catch {
        throw new Error("POLY_PROXY_ADDRESS must be a valid EVM address.");
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && /(?:^|\/)redeem\.(?:js|ts)$/.test(process.argv[1])) {
    redeemPositions().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
