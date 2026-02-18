
import { Strategy } from "./types.js";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket } from "../clients/websocket.js";
import { DipArbConfig } from "./dipArb.js";

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
}

export class SimpleHedgeStrategy implements Strategy {
    name = "Simple Hedge (Resting 35c)";

    // Clients
    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket?: PriceSocket;

    // Configuration
    private readonly MAX_CONCURRENT = 2;
    private tradeSizeUsd = 20; // Default $20
    private readonly LIMIT_PRICE = 0.35;
    private readonly COOLDOWN_MS = 15 * 60 * 1000; // 15 mins
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

    private loopInterval?: NodeJS.Timeout;

    constructor(config?: Partial<DipArbConfig>) {
        this.gammaClient = new GammaClient();
        // Socket is kept for logging/data collection, but not used for triggers
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));

        if (config?.tradeSizeUsd) {
            this.tradeSizeUsd = config.tradeSizeUsd;
        }
    }

    async init(clobClient: ClobClient, relayClient: RelayClient): Promise<void> {
        this.clobClient = clobClient;
        console.log(`[SimpleHedge] Init: ${this.MAX_CONCURRENT} mkts max, $${this.tradeSizeUsd}/side @ ${this.LIMIT_PRICE}`);
    }

    async run(): Promise<void> {
        // Main Loop (Every 5s)
        this.loopInterval = setInterval(async () => {
            if (this.destroyed) return;
            await this.maintenanceLoop();
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
                await this.handleMarketExpiry(state);
                this.activeMarkets.delete(marketId);
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

    private async checkFills(state: MarketState) {
        if (!this.clobClient) return;

        // Check YES Order
        if (state.yesOrderId && !state.yesFilled) {
            try {
                const order = await this.clobClient.getOrder(state.yesOrderId);
                // Polymarket API: size_matched or logic based on status
                // If status is MATCHED or size_matched >= original size
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
            } else {
                outcome = "DIRECTIONAL_WIN"; // Got lucky
                this.consecutiveFailures = 0;
            }
        } else {
            this.stats.neutral++;
        }

        console.log(`[SimpleHedge] Result for ${state.slug}: ${outcome}`);
        console.log(`[SimpleHedge] Fills: YES=${state.yesFilled} NO=${state.noFilled} | Res=${resolution}`);

        // Trigger Cooldown?
        if (this.consecutiveFailures >= 2) {
            console.warn(`[SimpleHedge] ⚠️ 2 Consecutive Directional Failures! Triggering 15m Cooldown.`);
            this.cooldownUntil = Date.now() + this.COOLDOWN_MS;
        }
    }

    private async findAndJoinMarket() {
        if (this.activeMarkets.size >= this.MAX_CONCURRENT || this.cooldownUntil) return;

        // Find next 5m market
        const nowSec = Date.now() / 1000;
        const interval = 300;
        const currentSlot = Math.floor(nowSec / interval) * interval;

        const slotsToCheck = 3;
        for (let i = 0; i < slotsToCheck; i++) {
            const startTimestamp = currentSlot + (i * interval);
            const slug = `${this.COIN.toLowerCase()}-updown-5m-${startTimestamp}`;

            // Uniqueness check
            let alreadyActive = false;
            for (const m of this.activeMarkets.values()) {
                if (m.slug === slug) alreadyActive = true;
            }
            if (alreadyActive) continue;

            // Fetch
            try {
                const markets = await this.gammaClient.getMarkets(`slug=${slug}`);
                if (markets && markets.length > 0) {
                    const m = markets[0];
                    if (m.closed) continue;

                    // Check time remaining
                    const parts = m.slug.split('-');
                    const slugTs = parseInt(parts[parts.length - 1]);
                    const endTime = (slugTs + interval) * 1000;

                    if (Date.now() >= endTime - 30000) continue; // Skip if < 30s left

                    // JOIN
                    await this.joinMarket(m, endTime);
                    if (this.activeMarkets.size >= this.MAX_CONCURRENT) break;
                }
            } catch (e) { }
        }
    }

    private async joinMarket(market: any, endTime: number) {
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
            startTime: Date.now()
        };

        this.activeMarkets.set(market.id, state);

        // PLACE ORDERS IMMEDIATELY
        await this.placeDualOrders(state);
    }

    private calcSize(): number {
        // Size = USD / Price
        // $20 / 0.35 ~= 57 shares
        return Math.floor(this.tradeSizeUsd / this.LIMIT_PRICE);
    }

    private async placeDualOrders(state: MarketState) {
        if (!this.clobClient) return;

        const size = this.calcSize();
        console.log(`[SimpleHedge] Posting Liquidity: Buy YES/NO @ ${this.LIMIT_PRICE} (Size: ${size}) for ${state.slug}`);

        // YES Order
        try {
            const yesOrder = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[0],
                price: this.LIMIT_PRICE,
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
                price: this.LIMIT_PRICE,
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

    // Passive Listener (just for logging)
    public onPriceUpdate(update: any) {
        // Removed LiveDataManager usage
        // Just log heavily if needed or no-op
    }

    private logStatus() {
        const active = Array.from(this.activeMarkets.values()).map(m => {
            const timeLeft = Math.max(0, (m.endTime - Date.now()) / 1000).toFixed(0);
            return `${m.slug} (${timeLeft}s) [Y:${m.yesFilled ? '✅' : '⏳'} N:${m.noFilled ? '✅' : '⏳'}]`;
        });
        console.log(`[SimpleHedge] Active: ${active.length}/${this.MAX_CONCURRENT} | ${active.join(', ')} | FailStreak: ${this.consecutiveFailures}`);
    }

    async cleanup(): Promise<void> {
        this.destroyed = true;
        if (this.loopInterval) clearInterval(this.loopInterval);
        console.log(`[SimpleHedge] Cleanup: Cancelling all active orders...`);
        for (const state of this.activeMarkets.values()) {
            await this.handleMarketExpiry(state);
        }
    }
}
