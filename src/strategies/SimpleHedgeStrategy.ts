
import { Strategy } from "./types.js";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket } from "../clients/websocket.js";
import { DipArbConfig } from "./dipArb.js";
import { redeemPositions } from "../scripts/redeem.js";

// --- UI / ANSI Helpers ---
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

interface MarketState {
    marketId: string;
    slug: string;
    tokenIds: string[]; // [YES, NO]
    endTime: number;
    yesOrderId?: string;
    noOrderId?: string;
    yesFilled: boolean;
    noFilled: boolean;
    ordersPlaced: boolean;
    startTime: number;
    prices: Map<string, number>; // Latest price per token
}

export class SimpleHedgeStrategy implements Strategy {
    name = "Simple Hedge (Resting 35c)";

    // Clients
    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket?: PriceSocket;

    // Configuration
    private readonly MAX_CONCURRENT = 1; // [FIX] Strict single-market discipline
    private tradeSizeUsd = 20; // Default $20
    private minPrice = 0.35;
    private maxPrice = 0.35;
    private currentRoundPrice = 0.35; // Selected price for the "current" market
    private COOLDOWN_MS = 10 * 60 * 1000; // Default 10 mins
    private readonly COIN = "BTC";

    // State
    private activeMarkets = new Map<string, MarketState>();
    private cooldownUntil: number | null = null;
    private consecutiveFailures = 0;
    private destroyed = false;

    // Stats
    private stats = {
        totalHedges: 0,
        hedgeSuccess: 0,
        directionalFailures: 0,
        neutral: 0
    };

    private isProcessing = false;
    private loopInterval?: NodeJS.Timeout;

    constructor(config?: Partial<DipArbConfig>) {
        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));

        if (config?.tradeSizeUsd) {
            this.tradeSizeUsd = config.tradeSizeUsd;
        }
        if (config?.limitPrice) {
            if (typeof config.limitPrice === 'number') {
                this.minPrice = config.limitPrice;
                this.maxPrice = config.limitPrice;
            } else if (typeof config.limitPrice === 'string') {
                const parts = config.limitPrice.split('-');
                if (parts.length === 2) {
                    this.minPrice = parseFloat(parts[0]);
                    this.maxPrice = parseFloat(parts[1]);
                }
            }
        }
        if (config?.cooldownMinutes) {
            this.COOLDOWN_MS = config.cooldownMinutes * 60 * 1000;
        }
    }

    async init(clobClient: ClobClient, relayClient: RelayClient): Promise<void> {
        this.clobClient = clobClient;
        console.log(`[SimpleHedge] Init: Max ${this.MAX_CONCURRENT} mkt, $${this.tradeSizeUsd}/side @ ${this.minPrice}-${this.maxPrice}c (Cooldown: ${this.COOLDOWN_MS / 60000}m)`);
    }

    async run(): Promise<void> {
        // Initial Auto-Redeem on startup
        console.log(color("🔄 Performing initial Auto-Redeem...", COLORS.CYAN));
        try {
            await redeemPositions();
            console.log(color("✅ Initial Auto-Redeem Complete.", COLORS.GREEN));
        } catch (e: any) {
            console.error(color(`❌ Initial Auto-Redeem Failed: ${e.message}`, COLORS.RED));
        }

        // Main Loop (Every 5s)
        this.loopInterval = setInterval(async () => {
            if (this.destroyed) return;
            if (this.isProcessing) return; // Skip if busy

            this.isProcessing = true;
            try {
                await this.maintenanceLoop();
            } catch (e) {
                console.error("[SimpleHedge] Loop Error:", e);
            } finally {
                this.isProcessing = false;
            }
        }, 5000);

        // Initial scan
        this.findAndJoinMarket();
    }

    private async maintenanceLoop() {
        const now = Date.now();

        // 1. Check Cooldown
        if (this.cooldownUntil && now < this.cooldownUntil) {
            const left = Math.ceil((this.cooldownUntil - now) / 1000);
            if (left % 30 === 0) console.log(`[SimpleHedge] Cooling down... ${left}s remaining.`);
            return;
        } else if (this.cooldownUntil && now >= this.cooldownUntil) {
            console.log(`[SimpleHedge] Cooldown expired. Resuming operations.`);
            this.cooldownUntil = null;
            this.consecutiveFailures = 0; // Reset counter
        }

        // 2. Manage Active Markets
        for (const [marketId, state] of this.activeMarkets.entries()) {
            // Check Expiry
            if (now >= state.endTime) {
                try {
                    await this.handleMarketExpiry(state);
                } catch (e) {
                    console.error(`[SimpleHedge] Error handling expiry for ${state.slug}:`, e);
                } finally {
                    this.activeMarkets.delete(marketId);
                }
                continue;
            }

            // Check Fills (if orders placed)
            if (state.ordersPlaced) {
                await this.checkFills(state);
            }
        }

        // 3. Scan for New Markets (if slots available)
        if (this.activeMarkets.size < this.MAX_CONCURRENT && !this.cooldownUntil) {
            await this.findAndJoinMarket();
        }

        // Log Status
        this.logStatus();
    }

    // ... (checkFills and handleMarketExpiry restored below) ...

    private async checkFills(state: MarketState) {
        if (!this.clobClient) return;

        // Check YES Order
        if (state.yesOrderId && !state.yesFilled) {
            try {
                const order = await this.clobClient.getOrder(state.yesOrderId);
                // @ts-ignore
                if (order && (order.status === "MATCHED" || parseFloat(order.size_matched) >= this.calcSize())) {
                    state.yesFilled = true;
                    console.log(`[SimpleHedge] ✅ YES Filled for ${state.slug}`);
                }
            } catch (e) { /* ignore 404 or errors */ }
        }

        // Check NO Order
        if (state.noOrderId && !state.noFilled) {
            try {
                const order = await this.clobClient.getOrder(state.noOrderId);
                // @ts-ignore
                if (order && (order.status === "MATCHED" || parseFloat(order.size_matched) >= this.calcSize())) {
                    state.noFilled = true;
                    console.log(`[SimpleHedge] ✅ NO Filled for ${state.slug}`);
                }
            } catch (e) { }
        }
    }

    private async handleMarketExpiry(state: MarketState) {
        console.log(`[SimpleHedge] 🏁 Market Expired: ${state.slug}`);

        // 1. Cancel Open Orders
        if (state.yesOrderId && !state.yesFilled) await this.cancelOrder(state.yesOrderId);
        if (state.noOrderId && !state.noFilled) await this.cancelOrder(state.noOrderId);

        // 2. Determine Outcome
        let resolution = "UNKNOWN";
        try {
            const markets = await this.gammaClient.getMarkets(`id=${state.marketId}`);
            // @ts-ignore
            const m = markets && markets.length > 0 ? markets[0] : null;
            if (m) resolution = m.winner || "UNKNOWN"; // 'YES' or 'NO'
        } catch (e) { }

        let outcome = "NEUTRAL";

        if (state.yesFilled && state.noFilled) {
            outcome = "HEDGE_SUCCESS";
            this.stats.totalHedges++;
            this.stats.hedgeSuccess++;
            this.consecutiveFailures = 0; // Reset on success
        } else if (state.yesFilled || state.noFilled) {
            // Partial Fill
            const sideHeld = state.yesFilled ? "YES" : "NO";
            // Check if we lost
            if (resolution !== "UNKNOWN" && resolution !== sideHeld) {
                outcome = "DIRECTIONAL_FAILURE";
                this.stats.directionalFailures++;
                this.consecutiveFailures++;
            } else if (resolution === "UNKNOWN") {
                outcome = "EXPOSED_UNCERTAIN";
                this.consecutiveFailures++; // Treat uncertainty as a failure to hedge
            } else {
                outcome = "DIRECTIONAL_WIN";
                // [FIX] Even if we won, the HEDGE failed (only 1 side filled). 
                // User wants 15m timeout if "hedge fails" consecutive.
                // So strictly increment failures here too?
                // "if 2 consecutive markets only any one side gets filled and hedge fails"
                // Winning directionally is still a hedge failure.
                this.consecutiveFailures++;
            }
        } else {
            this.stats.neutral++;
        }

        console.log(`[SimpleHedge] Result for ${state.slug}: ${outcome}`);
        console.log(`[SimpleHedge] Fills: YES=${state.yesFilled} NO=${state.noFilled} | Res=${resolution}`);

        // 3. AUTO-REDEEM
        console.log(color("🔄 Auto-Redeeming winnings...", COLORS.CYAN));
        try {
            await redeemPositions();
            console.log(color("✅ Auto-Redeem Complete.", COLORS.GREEN));
        } catch (e: any) {
            console.error(color(`❌ Auto-Redeem Failed: ${e.message}`, COLORS.RED));
        }

        // Trigger Cooldown?
        if (this.consecutiveFailures >= 2) {
            console.warn(`[SimpleHedge] ⚠️ ${this.consecutiveFailures} Consecutive Hedge Failures (Partial Fills). Triggering ${(this.COOLDOWN_MS / 60000).toFixed(1)}m Cooldown.`);
            this.cooldownUntil = Date.now() + this.COOLDOWN_MS;
        }
    }

    // [FIXED] findAndJoinMarket
    private async findAndJoinMarket() {
        if (this.activeMarkets.size >= this.MAX_CONCURRENT || this.cooldownUntil) return;

        // Find next 5m market
        const nowSec = Date.now() / 1000;
        const interval = 300;
        const currentSlot = Math.floor(nowSec / interval) * interval;

        // Check slots 0 (current), 1 (next), 2 (future)
        // STRICT RULE: Only join ONE valid market.
        for (let i = 0; i < 3; i++) {
            const startTimestamp = currentSlot + (i * interval);
            const expectedSlug = `${this.COIN.toLowerCase()}-updown-5m-${startTimestamp}`;

            // Uniqueness check
            let alreadyActive = false;
            for (const m of this.activeMarkets.values()) {
                if (m.slug === expectedSlug) alreadyActive = true;
            }
            if (alreadyActive) continue;

            // Fetch
            try {
                const markets = await this.gammaClient.getMarkets(`slug=${expectedSlug}`);
                if (markets && markets.length > 0) {
                    const m = markets[0];
                    if (m.closed) continue;

                    // [FIX] Strict Slug Match (Avoid fuzzy 15m matches)
                    if (m.slug !== expectedSlug) {
                        // console.log(`[SimpleHedge] Skip mismatch: ${m.slug} != ${expectedSlug}`);
                        continue;
                    }

                    // [FIX] Valid End Time Calculation (Trust Slug > API)
                    const slugParts = m.slug.split('-');
                    const slugTs = parseInt(slugParts[slugParts.length - 1]);
                    const startTime = slugTs * 1000;
                    const endTime = (slugTs + interval) * 1000;

                    const now = Date.now();
                    const timeLeftMs = endTime - now;

                    // [CONSTRAINT] If < 4m 30s remaining, skip this cycle (wait for next)
                    if (timeLeftMs < 270000) { // 4m 30s = 270s
                        // Only log if it's kinda close (e.g. > 30s left), and we haven't found a better candidate
                        if (timeLeftMs > 30000 && i === 0) {
                            console.log(`[SimpleHedge] Skipping ${m.slug} (${(timeLeftMs / 1000).toFixed(0)}s left). Too late to join (< 270s).`);
                        }
                        continue; // Check next slot
                    }

                    if (now >= endTime - 30000) continue; // Skip if basically ended

                    // JOIN
                    await this.joinMarket(m, startTime, endTime);

                    // [FIX] CRITICAL: Stop searching after finding ONE valid market.
                    break;
                }
            } catch (e) { }
        }
    }

    private async joinMarket(market: any, startTime: number, endTime: number) {
        console.log(`[SimpleHedge] Joining Market: ${market.slug}`);

        let tokenIds: string[] = [];
        try {
            if (typeof market.clobTokenIds === 'string') tokenIds = JSON.parse(market.clobTokenIds);
            else if (Array.isArray(market.clobTokenIds)) tokenIds = market.clobTokenIds as string[];
        } catch (e) { }

        if (tokenIds.length !== 2) return;

        const state: MarketState = {
            marketId: market.id,
            slug: market.slug,
            tokenIds,
            endTime,
            yesFilled: false,
            noFilled: false,
            ordersPlaced: false,
            startTime,
            prices: new Map()
        };

        // [FIX] Register IMMEDIATELY to prevent double-join race condition
        this.activeMarkets.set(market.id, state);

        // Subscribe to prices
        if (this.priceSocket) {
            this.priceSocket.connect(tokenIds);
        }

        // [FIX] Seed Initial Prices from CLOB to ensure accuracy
        if (this.clobClient) {
            try {
                // Fetch midpoints for both tokens in parallel
                const [mid1, mid2] = await Promise.all([
                    this.clobClient.getMidpoint(tokenIds[0]),
                    this.clobClient.getMidpoint(tokenIds[1])
                ]);

                if (mid1 && mid1.mid) state.prices.set(tokenIds[0], parseFloat(mid1.mid));
                if (mid2 && mid2.mid) state.prices.set(tokenIds[1], parseFloat(mid2.mid));

                console.log(`[SimpleHedge] Seeded Prices: ${mid1?.mid || '?'} / ${mid2?.mid || '?'}`);
            } catch (e) {
                console.warn(`[SimpleHedge] Failed to fetch initial midpoints: ${e}`);
            }
        }

        // Generate Random Price for this round
        this.currentRoundPrice = this.minPrice + Math.random() * (this.maxPrice - this.minPrice);
        // Round to 1 tick (0.01)? Or allow decimals? Gamma allows specific, CLOB might reject.
        // Assuming 2 decimals for Polymarket (cents).
        this.currentRoundPrice = Math.floor(this.currentRoundPrice * 100) / 100;

        // PLACE ORDERS IMMEDIATELY
        await this.placeDualOrders(state);
    }

    private calcSize(): number {
        // Size = USD / Price
        return Math.floor(this.tradeSizeUsd / this.currentRoundPrice);
    }

    private async placeDualOrders(state: MarketState) {
        if (!this.clobClient) return;

        const size = this.calcSize();
        console.log(`[SimpleHedge] Posting Liquidity: Buy YES/NO @ ${this.currentRoundPrice.toFixed(2)} (Size: ${size}) for ${state.slug}`);

        // YES Order
        try {
            const yesOrder = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[0],
                price: this.currentRoundPrice,
                side: Side.BUY,
                size: size
            });
            if (yesOrder && yesOrder.orderID) {
                state.yesOrderId = yesOrder.orderID;
            }
        } catch (e: any) {
            console.error(`[SimpleHedge] Failed to post YES: ${e.message}`);
        }

        // NO Order
        try {
            const noOrder = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[1],
                price: this.currentRoundPrice,
                side: Side.BUY,
                size: size
            });
            if (noOrder && noOrder.orderID) {
                state.noOrderId = noOrder.orderID;
            }
        } catch (e: any) {
            console.error(`[SimpleHedge] Failed to post NO: ${e.message}`);
        }

        state.ordersPlaced = true;
    }

    private async cancelOrder(orderId: string) {
        if (!this.clobClient) return;
        try {
            await this.clobClient.cancelOrder({ orderID: orderId });
            console.log(`[SimpleHedge] Cancelled Order ${orderId}`);
        } catch (e) { /* ignore already cancelled/filled */ }
    }

    // Passive Listener
    public onPriceUpdate(update: any) {
        const tokenId = update.asset_id;
        const currentPrice = parseFloat(update.price);

        // Update active markets
        for (const state of this.activeMarkets.values()) {
            if (state.tokenIds.includes(tokenId)) {
                state.prices.set(tokenId, currentPrice);
                break;
            }
        }
    }

    private logStatus() {
        if (this.activeMarkets.size === 0) {
            if (this.consecutiveFailures > 0) {
                console.log(`[SimpleHedge] Idle. FailStreak: ${this.consecutiveFailures}`);
            }
            return;
        }

        for (const state of this.activeMarkets.values()) {
            const now = Date.now();

            // Format time display
            let timeStr = "";
            let statusIcon = "";
            let timerColor = COLORS.WHITE;

            if (now < state.startTime) {
                const startsIn = Math.ceil((state.startTime - now) / 1000);
                timeStr = `Starts: ${Math.floor(startsIn / 60)}m ${startsIn % 60}s`;
                statusIcon = "⏳";
                timerColor = COLORS.YELLOW;
            } else {
                const endsIn = Math.max(0, Math.ceil((state.endTime - now) / 1000));
                timeStr = `Ends: ${Math.floor(endsIn / 60)}m ${endsIn % 60}s`;
                statusIcon = "🟢";
                timerColor = COLORS.GREEN;
            }

            const p1 = state.prices.get(state.tokenIds[0])?.toFixed(2) || "?.??";
            const p2 = state.prices.get(state.tokenIds[1])?.toFixed(2) || "?.??";

            const posStr = `[Y:${state.yesFilled ? '✅' : '⏳'} N:${state.noFilled ? '✅' : '⏳'}]`;

            console.log(
                `${color("[STATUS]", COLORS.CYAN)} ` +
                `${color(timeStr.padEnd(14), timerColor)} | ` +
                `Px: ${color(p1, COLORS.GREEN)}/${color(p2, COLORS.RED)} | ` +
                `${posStr} ${statusIcon} ${state.slug}`
            );
        }
    }

    async cleanup(): Promise<void> {
        this.destroyed = true;
        if (this.loopInterval) clearInterval(this.loopInterval);
        if (this.priceSocket) this.priceSocket.close();
        console.log(`[SimpleHedge] Cleanup: Cancelling all active orders...`);
        for (const state of this.activeMarkets.values()) {
            await this.handleMarketExpiry(state);
        }
    }
}
