
import { Strategy } from "./types.js";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket } from "../clients/websocket.js";
import { WeightedStrategyConfig } from "./BaseWeightedStrategy.js";
export type DipArbConfig = WeightedStrategyConfig;
import { redeemPositions } from "../scripts/redeem.js";
import { SideInput } from "../config/args.js";

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
    startTime: number;
    prices: Map<string, number>; // Latest price per token

    // Orders
    yesOrderId?: string;
    noOrderId?: string;
    yesFilled: boolean;
    noFilled: boolean;
    ordersPlaced: boolean;
}

export class Btc15mExtremeMeanReversionStrategy implements Strategy {
    name = "BTC 15m Extreme Mean Reversion Strategy";

    // Clients
    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket?: PriceSocket;

    // Configuration
    private readonly MAX_CONCURRENT = 1;
    private tradeSizeUsd = 20;
    private limitPrice = 0.01; // Default Extreme
    private side: SideInput = 'BOTH';
    private readonly COIN = "BTC";

    // State
    private activeMarkets = new Map<string, MarketState>();
    private isProcessing = false;
    private loopInterval?: NodeJS.Timeout;

    constructor(config?: Partial<DipArbConfig>) {
        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));

        if (config?.tradeSizeUsd) {
            this.tradeSizeUsd = config.tradeSizeUsd;
        }
        if (config?.limitPrice) {
            this.limitPrice = Number(config.limitPrice) || 0.01;
        }
        if (config?.side) {
            this.side = config.side;
        }
    }

    async init(clobClient: ClobClient): Promise<void> {
        this.clobClient = clobClient;
        console.log(`[Btc15mExtreme] Init: Target ${this.COIN}, Size $${this.tradeSizeUsd}, Price ${this.limitPrice}c, Side ${this.side}`);
    }

    async run(): Promise<void> {
        // Initial Auto-Redeem
        console.log(color("🔄 Auto-Redeem on startup...", COLORS.CYAN));
        try {
            await redeemPositions();
        } catch (e) {
            console.error("Redeem failed:", e);
        }

        // Main Loop
        this.loopInterval = setInterval(async () => {
            if (this.isProcessing) return;
            this.isProcessing = true;
            try {
                await this.maintenanceLoop();
            } catch (e) {
                console.error("[Btc15mExtreme] Loop Error:", e);
            } finally {
                this.isProcessing = false;
            }
        }, 5000);

        // Initial scan
        this.findAndJoinMarket();
    }

    private async maintenanceLoop() {
        const now = Date.now();

        // 1. Manage Active Markets
        for (const [marketId, state] of this.activeMarkets.entries()) {
            if (now >= state.endTime) {
                await this.handleMarketExpiry(state);
                this.activeMarkets.delete(marketId);
                continue;
            }

            if (state.ordersPlaced) {
                await this.checkFills(state);
            }
        }

        // 2. Scan for New Markets
        if (this.activeMarkets.size < this.MAX_CONCURRENT) {
            await this.findAndJoinMarket();
        }

        this.logStatus();
    }

    private async findAndJoinMarket() {
        if (this.activeMarkets.size >= this.MAX_CONCURRENT) return;

        // Find next 15m market
        // Strategy: 15m markets usually start on the hour, 15, 30, 45.
        // We look for upcoming markets.
        const nowSec = Math.floor(Date.now() / 1000);
        const interval = 900; // 15m

        // Check next few slots
        for (let i = 0; i < 4; i++) {
            // We want markets that are OPEN or opening very soon.
            // Usually we target the one closest to now?
            // Let's use the scan pattern from DipArb but simplified.
            // Just construct slug? 
            // BTC 15m slugs: "btc-updown-15m-TIMESTAMP"

            // Look for the "Current" or "Next" slot.
            // Current slot might be active.
            // We want to enter EARLY to rest orders.

            const slotStart = Math.floor(nowSec / interval) * interval + (i * interval);
            const slug = `${this.COIN.toLowerCase()}-updown-15m-${slotStart}`;

            // Avoid duplicates
            let known = false;
            for (const m of this.activeMarkets.values()) {
                if (m.slug === slug) known = true;
            }
            if (known) continue;

            try {
                const markets = await this.gammaClient.getMarkets(`slug=${slug}`);
                if (markets && markets.length > 0) {
                    const m = markets[0];
                    if (m.closed) continue;

                    // Check time
                    const endTime = new Date(m.events?.[0]?.endDate || m.endDateIso).getTime();
                    const startTime = new Date(m.events?.[0]?.startDate || m.startDateIso).getTime(); // Gamma might not have startDateIso sometimes?
                    // Better to rely on slug if possible or gamma fields.

                    if (Date.now() >= endTime - 60000) continue; // Too late

                    await this.joinMarket(m, startTime, endTime);
                    return; // Found one
                }
            } catch (e) { }
        }
    }

    private async joinMarket(market: any, startTime: number, endTime: number) {
        console.log(`[Btc15mExtreme] Joining ${market.slug}`);

        let tokenIds: string[] = [];
        try {
            if (typeof market.clobTokenIds === 'string') tokenIds = JSON.parse(market.clobTokenIds);
            else if (Array.isArray(market.clobTokenIds)) tokenIds = market.clobTokenIds;
        } catch (e) { }

        if (tokenIds.length !== 2) return;

        const state: MarketState = {
            marketId: market.id,
            slug: market.slug,
            tokenIds,
            endTime,
            startTime,
            yesFilled: false,
            noFilled: false,
            ordersPlaced: false,
            prices: new Map()
        };

        this.activeMarkets.set(market.id, state);
        if (this.priceSocket) this.priceSocket.connect(tokenIds);

        // [FIX] Persistence Check
        await this.loadStateFromChain(state);

        if (!state.ordersPlaced) {
            await this.placeOrders(state);
        } else {
            console.log(color(`[Btc15mExtreme] ⚠️ Found existing state for ${state.slug}. Skipping new orders.`, COLORS.YELLOW));
            this.logStatus();
        }
    }

    private async loadStateFromChain(state: MarketState) {
        if (!this.clobClient) return;

        console.log(`[Btc15mExtreme] Checking existing state for ${state.slug}...`);

        try {
            // 1. Check Open Orders
            const openOrders = await this.clobClient.getOpenOrders({ market: state.tokenIds[0] }); // Just use one to fetch all? API might filter.
            // Actually getOpenOrders usually returns ALL active orders for user.
            // We can filter client-side.
            const allOrders: any[] = Array.isArray((openOrders as any).orders) ? (openOrders as any).orders : []; // Safety
            // If getOpenOrders returns object with next_cursor, handle it? usually yes.
            // But clob-client might return array directly or wrapped. 
            // Let's assume wrapped .orders based on DipArbStrategy.

            // Re-fetch to be safe if `openOrders` is not the array
            // Actually DipArbStrategy used: const orders = (openOrders as any).orders || openOrders;
            const orders = (openOrders as any).orders || openOrders;

            if (Array.isArray(orders)) {
                for (const o of orders) {
                    if (state.tokenIds.includes(o.asset_id)) {
                        console.log(`[Btc15mExtreme] Found Active Order: ${o.orderID} (${o.side} ${o.size})`);
                        state.ordersPlaced = true;

                        // Map to side
                        if (o.asset_id === state.tokenIds[0]) state.yesOrderId = o.orderID;
                        if (o.asset_id === state.tokenIds[1]) state.noOrderId = o.orderID;
                    }
                }
            }

            // 2. Check Trades / Positions (Fills)
            // If we have a position, we consider it "Filled"
            const trades = await this.clobClient.getTrades({ market: state.tokenIds[0] }); // Filter by market maker? 
            // getTrades usually takes ?market=... or ?asset_id=...
            // Checking documentation or usage... 
            // To be safe/simple, we can just imply fill if we have a position?
            // But we don't have getPositions in this clobClient version (from DipArbStrategy comments).
            // So we use getTrades.

            const tradeList = (trades as any).trades || trades;
            if (Array.isArray(tradeList)) {
                for (const t of tradeList) {
                    if (state.tokenIds.includes(t.asset_id) && t.side === 'BUY') {
                        console.log(`[Btc15mExtreme] Found Past Trade: ${t.size} @ ${t.price}`);
                        state.ordersPlaced = true;
                        // Mark filled
                        if (t.asset_id === state.tokenIds[0]) state.yesFilled = true;
                        if (t.asset_id === state.tokenIds[1]) state.noFilled = true;
                    }
                }
            }

        } catch (e) {
            console.error(`[Btc15mExtreme] Failed to load state:`, e);
            // Safety: If we fail to check, do we place orders? 
            // Better to allow duplicate than to do nothing? 
            // User wants strict limit. So maybe FAIL SAFE = Assume placed?
            // No, unrelated error should not block.
        }
    }

    private calcSize(): number {
        return Math.floor(this.tradeSizeUsd / this.limitPrice);
    }

    private async placeOrders(state: MarketState) {
        if (!this.clobClient) return;

        const size = this.calcSize();
        console.log(`[Btc15mExtreme] Placing Orders: Side=${this.side} Price=${this.limitPrice} Size=${size}`);

        const placeBuy = async (tokenId: string, sideLabel: string) => {
            try {
                const order = await this.clobClient!.createAndPostOrder({
                    tokenID: tokenId,
                    price: this.limitPrice,
                    side: Side.BUY,
                    size: size
                });
                return order.orderID;
            } catch (e: any) {
                console.error(`[Btc15mExtreme] Failed to place ${sideLabel}: ${e.message}`);
                return undefined;
            }
        };

        // YES = tokenIds[0], NO = tokenIds[1]

        if (this.side === 'YES' || this.side === 'BOTH') {
            state.yesOrderId = await placeBuy(state.tokenIds[0], 'YES');
        }

        if (this.side === 'NO' || this.side === 'BOTH') {
            state.noOrderId = await placeBuy(state.tokenIds[1], 'NO');
        }

        state.ordersPlaced = true;
    }

    private async checkFills(state: MarketState) {
        if (!this.clobClient) return;

        if (state.yesOrderId && !state.yesFilled) {
            try {
                const o = await this.clobClient.getOrder(state.yesOrderId);
                // @ts-ignore
                if (o && (o.status === "MATCHED" || parseFloat(o.size_matched) > 0)) {
                    state.yesFilled = true;
                    console.log(color(`[Btc15mExtreme] 🚀 YES FILLED! Waiting for mean reversion...`, COLORS.GREEN));
                }
            } catch (e) { }
        }

        if (state.noOrderId && !state.noFilled) {
            try {
                const o = await this.clobClient.getOrder(state.noOrderId);
                // @ts-ignore
                if (o && (o.status === "MATCHED" || parseFloat(o.size_matched) > 0)) {
                    state.noFilled = true;
                    console.log(color(`[Btc15mExtreme] 🚀 NO FILLED! Waiting for mean reversion...`, COLORS.GREEN));
                }
            } catch (e) { }
        }
    }

    private async handleMarketExpiry(state: MarketState) {
        console.log(`[Btc15mExtreme] Market Expired: ${state.slug}`);
        // Cancel logic if needed? 
        // If not filled, cancel.
        if (state.yesOrderId && !state.yesFilled) await this.cancelOrder(state.yesOrderId);
        if (state.noOrderId && !state.noFilled) await this.cancelOrder(state.noOrderId);

        // Redeem
        try {
            await redeemPositions();
            console.log(color("✅ Auto-Redeem Done", COLORS.GREEN));
        } catch (e) { }
    }

    private async cancelOrder(id: string) {
        if (!this.clobClient) return;
        try { await this.clobClient.cancelOrder({ orderID: id }); } catch (e) { }
    }

    private onPriceUpdate(update: any) {
        const tokenId = update.asset_id;
        const price = parseFloat(update.price);
        for (const s of this.activeMarkets.values()) {
            if (s.tokenIds.includes(tokenId)) {
                s.prices.set(tokenId, price);
                break;
            }
        }
    }

    private logStatus() {
        if (this.activeMarkets.size === 0) {
            console.log(`[Btc15mExtreme] Scanning...`);
            return;
        }

        for (const s of this.activeMarkets.values()) {
            const now = Date.now();
            const left = Math.max(0, Math.ceil((s.endTime - now) / 1000));

            const p1 = s.prices.get(s.tokenIds[0])?.toFixed(3) || "?.???";
            const p2 = s.prices.get(s.tokenIds[1])?.toFixed(3) || "?.???";

            console.log(
                color(`[Btc15mExtreme] ${s.slug.split('-').pop()}`, COLORS.CYAN) +
                ` | Time: ${Math.floor(left / 60)}m${left % 60}s` +
                ` | Px: ${color(p1, COLORS.GREEN)}/${color(p2, COLORS.RED)}` +
                ` | Fills: Y=${s.yesFilled ? '✅' : '⏳'} N=${s.noFilled ? '✅' : '⏳'}`
            );
        }
    }

    async cleanup() {
        if (this.loopInterval) clearInterval(this.loopInterval);
        this.priceSocket?.close();
        console.log("Cleanup done.");
    }
}
