import { Strategy } from "./types.js";
import { ClobClient, Side, OrderType, AssetType } from "@polymarket/clob-client-v2";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket } from "../clients/websocket.js";
import { WeightedStrategyConfig } from "./BaseWeightedStrategy.js";
export type DipArbConfig = WeightedStrategyConfig;
import { redeemPositions } from "../scripts/redeem.js";
import { PriceLogger } from "../lib/priceLogger.js";
import { PnlManager } from "../lib/pnlManager.js";

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
    tokenIds: string[];
    endTime: number;
    yesOrderId?: string;
    noOrderId?: string;
    yesFilled: boolean;
    noFilled: boolean;
    ordersPlaced: boolean;
    startTime: number;
    prices: Map<string, number>;
    status: 'ACTIVE' | 'EXPIRED';
    targetShares: number;
    roundPrice: number;    

    // Phase Tracking
    phase: 'LEG_IN' | 'HEDGE' | 'HEDGED';
    hedgeSide?: 'YES' | 'NO';
    hedgeOrderId?: string;
    hedgeTargetPrice?: number;
}

export class Btc5mDynamicHedgeStrategy implements Strategy {
    name = "BTC 5m Dynamic Hedge Strategy (Leg-In)";

    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket?: PriceSocket;
    private pnlManager: PnlManager;

    private readonly MAX_CONCURRENT = 1;
    private tradeSizeUsd = 20;
    private tradeShares = 0;
    private minPrice = 0.35;
    private maxPrice = 0.35;
    private targetPairCost = 0.95; // [NEW] Default target pair cost = 0.95 (5c profit)
    
    private lastCheckFillsTs = 0;
    private COOLDOWN_MS = 10 * 60 * 1000;
    private readonly COIN: string;

    private activeMarkets = new Map<string, MarketState>();
    private cooldownUntil: number | null = null;
    private consecutiveFailures = 0;
    private destroyed = false;

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
        this.pnlManager = new PnlManager();
        this.COIN = (config as any)?.coin || "BTC";

        if (config?.tradeSizeUsd) this.tradeSizeUsd = config.tradeSizeUsd;
        if (config?.shares) this.tradeShares = config.shares;
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
        if (config?.cooldownMinutes) this.COOLDOWN_MS = config.cooldownMinutes * 60 * 1000;
        // Allows config to override target pair cost
        if ((config as any)?.targetPairCost) this.targetPairCost = (config as any).targetPairCost;
    }

    async init(clobClient: ClobClient): Promise<void> {
        this.clobClient = clobClient;
        const sizeDesc = this.tradeShares > 0 ? `${this.tradeShares} shares` : `$${this.tradeSizeUsd}/side`;
        console.log(`[Btc5mDynamicHedge] Init: Max ${this.MAX_CONCURRENT} mkt, ${sizeDesc} | Leg-In @ ${this.minPrice}-${this.maxPrice}c | Target Cost: ${this.targetPairCost}`);
    }

    async run(): Promise<void> {
        console.log(color("🔄 Performing initial Auto-Redeem...", COLORS.CYAN));
        try {
            await redeemPositions();
            console.log(color("✅ Initial Auto-Redeem Complete.", COLORS.GREEN));
        } catch (e: any) {
            console.error(color(`❌ Initial Auto-Redeem Failed: ${e.message}`, COLORS.RED));
        }

        this.loopInterval = setInterval(async () => {
            if (this.destroyed) return;
            if (this.isProcessing) return;
            this.isProcessing = true;
            try {
                await this.maintenanceLoop();
            } catch (e) {
                console.error("[Btc5mDynamicHedge] Loop Error:", e);
            } finally {
                this.isProcessing = false;
            }
        }, 5000);

        this.findAndJoinMarket();
    }

    private async maintenanceLoop() {
        const now = Date.now();

        if (this.cooldownUntil && now < this.cooldownUntil) {
            const left = Math.ceil((this.cooldownUntil - now) / 1000);
            if (left % 30 === 0) console.log(`[Btc5mDynamicHedge] Cooling down... ${left}s remaining.`);
            return;
        } else if (this.cooldownUntil && now >= this.cooldownUntil) {
            console.log(`[Btc5mDynamicHedge] Cooldown expired. Resuming.`);
            this.cooldownUntil = null;
            this.consecutiveFailures = 0;
        }

        let minTimeLeft = Infinity;
        for (const [marketId, state] of this.activeMarkets.entries()) {
            if (now >= state.endTime && state.status !== 'EXPIRED') {
                state.status = 'EXPIRED';
                this.handleMarketExpiry(state).then(() => {
                    this.activeMarkets.delete(marketId);
                }).catch(e => {
                    console.error(`[Btc5mDynamicHedge] Expiry error:`, e);
                    this.activeMarkets.delete(marketId);
                });
                continue;
            }

            if (state.status === 'ACTIVE') {
                const timeLeft = Math.max(0, (state.endTime - now) / 1000);
                if (timeLeft < minTimeLeft) minTimeLeft = timeLeft;

                if (state.phase === 'HEDGE') {
                    await this.manageHedge(state, timeLeft);
                }
            }

            if (state.ordersPlaced && state.status === 'ACTIVE') {
                await this.checkFills(state);
            }
        }

        const activeCount = Array.from(this.activeMarkets.values()).filter(m => m.status === 'ACTIVE').length;
        if (!this.cooldownUntil) {
            if (activeCount === 0 || (activeCount === 1 && minTimeLeft < 60)) {
                await this.findAndJoinMarket();
            }
        }

        this.logStatus();
    }

    private async manageHedge(state: MarketState, timeLeftSeconds: number) {
        if (state.phase !== 'HEDGE' || !state.hedgeOrderId || !state.hedgeTargetPrice) return;
        
        let relaxedPrice = state.hedgeTargetPrice;
        if (timeLeftSeconds < 20) {
            relaxedPrice = Math.min(0.99, state.hedgeTargetPrice + 0.15);
        } else if (timeLeftSeconds < 60) {
            relaxedPrice = Math.min(0.99, state.hedgeTargetPrice + 0.05); // Breakeven roughly
        }

        relaxedPrice = Math.floor(relaxedPrice * 100) / 100;

        if (relaxedPrice > state.hedgeTargetPrice + 0.01) {
            console.log(color(`[Btc5mDynamicHedge] ⏳ Time running out (${timeLeftSeconds.toFixed(0)}s). Relaxing HEDGE bid to ${relaxedPrice}`, COLORS.YELLOW));
            
            await this.cancelOrder(state.hedgeOrderId);
            state.hedgeTargetPrice = relaxedPrice;
            state.hedgeOrderId = undefined;

            const tokenIdx = state.hedgeSide === 'YES' ? 0 : 1;
            try {
                const hOrder = await this.clobClient!.createAndPostOrder({
                    tokenID: state.tokenIds[tokenIdx],
                    price: state.hedgeTargetPrice,
                    side: Side.BUY,
                    size: state.targetShares
                }, { tickSize: "0.01" });
                if (hOrder && hOrder.orderID) {
                    state.hedgeOrderId = hOrder.orderID;
                }
            } catch (e: any) {
                console.error(`[Btc5mDynamicHedge] Failed to relax HEDGE order: ${e.message}`);
            }
        }
    }

    private async checkFills(state: MarketState) {
        if (!this.clobClient) return;

        const now = Date.now();
        if (now - this.lastCheckFillsTs < 3000) return;
        this.lastCheckFillsTs = now;

        const promises = [];

        if (state.phase === 'LEG_IN') {
            if (state.yesOrderId && !state.yesFilled) {
                promises.push((async () => {
                    try {
                        const order = await this.clobClient!.getOrder(state.yesOrderId!);
                        // @ts-ignore
                        if (order && (order.status === "MATCHED" || order.status === "FILLED" || parseFloat(order.size_matched) >= state.targetShares)) {
                            state.yesFilled = true;
                            console.log(`[Btc5mDynamicHedge] ✅ YES Leg-In Filled for ${state.slug}`);
                            await this.triggerHedgeMode(state, 'NO');
                        }
                    } catch (e: any) { 
                        if (!e?.message?.includes('ETIMEDOUT')) console.error(`[Btc5mDynamicHedge] YES GetOrder Error: ${e.message}`);
                    }
                })());
            }

            if (state.noOrderId && !state.noFilled) {
                promises.push((async () => {
                    try {
                        const order = await this.clobClient!.getOrder(state.noOrderId!);
                        // @ts-ignore
                        if (order && (order.status === "MATCHED" || order.status === "FILLED" || parseFloat(order.size_matched) >= state.targetShares)) {
                            state.noFilled = true;
                            console.log(`[Btc5mDynamicHedge] ✅ NO Leg-In Filled for ${state.slug}`);
                            if (!state.yesFilled) await this.triggerHedgeMode(state, 'YES');
                        }
                    } catch (e: any) { 
                        if (!e?.message?.includes('ETIMEDOUT')) console.error(`[Btc5mDynamicHedge] NO GetOrder Error: ${e.message}`);
                    }
                })());
            }
        } else if (state.phase === 'HEDGE') {
            if (state.hedgeOrderId && (!state.yesFilled || !state.noFilled)) {
                promises.push((async () => {
                    try {
                        const order = await this.clobClient!.getOrder(state.hedgeOrderId!);
                        // @ts-ignore
                        if (order && (order.status === "MATCHED" || order.status === "FILLED" || parseFloat(order.size_matched) >= state.targetShares)) {
                            if (state.hedgeSide === 'YES') state.yesFilled = true;
                            else state.noFilled = true;
                            state.phase = 'HEDGED';
                            console.log(color(`[Btc5mDynamicHedge] 🛡️ HEDGE SECURED for ${state.slug}!`, COLORS.BRIGHT + COLORS.GREEN));
                        }
                    } catch (e: any) { 
                        if (!e?.message?.includes('ETIMEDOUT')) console.error(`[Btc5mDynamicHedge] Hedge GetOrder Error: ${e.message}`);
                    }
                })());
            }
        }

        if (promises.length > 0) {
            await Promise.allSettled(promises);
        }
    }

    private async triggerHedgeMode(state: MarketState, sideToHedge: 'YES' | 'NO') {
        state.phase = 'HEDGE';
        state.hedgeSide = sideToHedge;
        
        if (sideToHedge === 'NO' && state.noOrderId) {
            await this.cancelOrder(state.noOrderId);
            state.noOrderId = undefined;
        } else if (sideToHedge === 'YES' && state.yesOrderId) {
            await this.cancelOrder(state.yesOrderId);
            state.yesOrderId = undefined;
        }

        let targetCost = this.targetPairCost - state.roundPrice;
        if (targetCost > 0.99) targetCost = 0.99;
        if (targetCost < 0.01) targetCost = 0.01;
        state.hedgeTargetPrice = Math.floor(targetCost * 100) / 100;

        console.log(color(`[Btc5mDynamicHedge] 🔄 ENTERING HEDGE MODE. Bidding ${sideToHedge} @ ${state.hedgeTargetPrice}`, COLORS.MAGENTA));

        const tokenIdx = sideToHedge === 'YES' ? 0 : 1;
        try {
            const hOrder = await this.clobClient!.createAndPostOrder({
                tokenID: state.tokenIds[tokenIdx],
                price: state.hedgeTargetPrice,
                side: Side.BUY,
                size: state.targetShares
            }, { tickSize: "0.01" });
            
            if (hOrder && hOrder.orderID) {
                state.hedgeOrderId = hOrder.orderID;
            }
        } catch (e: any) {
            console.error(`[Btc5mDynamicHedge] Failed to post HEDGE: ${e.message}`);
        }
    }

    private async handleMarketExpiry(state: MarketState) {
        console.log(`[Btc5mDynamicHedge] 🏁 Market Expired: ${state.slug}`);

        if (state.yesOrderId && !state.yesFilled) await this.cancelOrder(state.yesOrderId);
        if (state.noOrderId && !state.noFilled) await this.cancelOrder(state.noOrderId);
        if (state.hedgeOrderId && state.phase === 'HEDGE') await this.cancelOrder(state.hedgeOrderId);

        let resolution = "UNKNOWN";
        try {
            const markets = await this.gammaClient.getMarkets(`id=${state.marketId}`);
            // @ts-ignore
            const m = markets && markets.length > 0 ? markets[0] : null;
            if (m) resolution = m.winner || "UNKNOWN";
        } catch (e) { }

        let outcome = "NEUTRAL";

        if (state.yesFilled && state.noFilled) {
            outcome = "HEDGE_SUCCESS";
            this.stats.totalHedges++;
            this.stats.hedgeSuccess++;
            this.consecutiveFailures = 0;
        } else if (state.yesFilled || state.noFilled) {
            const sideHeld = state.yesFilled ? "YES" : "NO";
            if (resolution !== "UNKNOWN" && resolution !== sideHeld) {
                outcome = "DIRECTIONAL_FAILURE_UNHEDGED";
                this.stats.directionalFailures++;
                this.consecutiveFailures++;
            } else if (resolution === "UNKNOWN") {
                outcome = "EXPOSED_UNCERTAIN_UNHEDGED";
                this.consecutiveFailures++;
            } else {
                outcome = "DIRECTIONAL_WIN_UNHEDGED";
                this.consecutiveFailures++;
            }
            this.stats.neutral++;
        }

        if (outcome === 'HEDGE_SUCCESS') {
            const profit = (state.targetShares * (this.targetPairCost - state.roundPrice - (state.hedgeTargetPrice || 0)));
            this.pnlManager.closeCycle(state.marketId, 'WIN', profit);
        } else if (outcome.includes('FAILURE') || outcome.includes('EXPOSED')) {
            this.pnlManager.closeCycle(state.marketId, 'LOSS', -(state.targetShares * state.roundPrice));
        } else {
            this.pnlManager.closeCycle(state.marketId, 'EXPIRED', 0);
        }

        console.log(`[Btc5mDynamicHedge] Result for ${state.slug}: ${outcome}`);

        console.log(color("🔄 Auto-Redeeming...", COLORS.CYAN));
        try {
            await redeemPositions();
        } catch (e: any) {
            console.error(color(`❌ Auto-Redeem Failed: ${e.message}`, COLORS.RED));
        }

        if (this.consecutiveFailures >= 2) {
            console.warn(color(`[Btc5mDynamicHedge] ⚠️ ${this.consecutiveFailures} Unhedged Exposures. Cooldown ${(this.COOLDOWN_MS / 60000).toFixed(1)}m.`, COLORS.RED));
            this.cooldownUntil = Date.now() + this.COOLDOWN_MS;
        }
    }

    private async findAndJoinMarket() {
        if (this.cooldownUntil) return;
        const activeCount = Array.from(this.activeMarkets.values()).filter(m => m.status === 'ACTIVE').length;
        if (activeCount >= this.MAX_CONCURRENT + 1) return;

        const nowSec = Date.now() / 1000;
        const interval = 300;
        const currentSlot = Math.floor(nowSec / interval) * interval;

        for (let i = 0; i < 3; i++) {
            const startTimestamp = currentSlot + (i * interval);
            const expectedSlug = `${this.COIN.toLowerCase()}-updown-5m-${startTimestamp}`;

            if (Array.from(this.activeMarkets.values()).some(m => m.slug === expectedSlug)) continue;

            try {
                const markets = await this.gammaClient.getMarkets(`slug=${expectedSlug}`);
                if (markets && markets.length > 0) {
                    const m = markets[0];
                    if (m.closed || m.slug !== expectedSlug) continue;

                    const slugParts = m.slug.split('-');
                    const slugTs = parseInt(slugParts[slugParts.length - 1]);
                    const startTime = slugTs * 1000;
                    const endTime = (slugTs + interval) * 1000;
                    const now = Date.now();
                    const timeLeftMs = endTime - now;

                    if (timeLeftMs < 270000) continue;
                    if (now >= endTime - 30000) continue;

                    await this.joinMarket(m, startTime, endTime);
                    break;
                }
            } catch (e) { }
        }
    }

    private async joinMarket(market: any, startTime: number, endTime: number) {
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
            prices: new Map(),
            status: 'ACTIVE',
            targetShares: 0,
            roundPrice: 0,
            phase: 'LEG_IN'
        };

        this.activeMarkets.set(market.id, state);
        if (this.priceSocket) this.priceSocket.connect(tokenIds);

        if (this.clobClient) {
            try {
                const [mid1, mid2] = await Promise.all([
                    this.clobClient.getMidpoint(tokenIds[0]),
                    this.clobClient.getMidpoint(tokenIds[1])
                ]);
                if (mid1?.mid) state.prices.set(tokenIds[0], parseFloat(mid1.mid));
                if (mid2?.mid) state.prices.set(tokenIds[1], parseFloat(mid2.mid));
            } catch (e) { }
        }

        let roundPrice = this.minPrice + Math.random() * (this.maxPrice - this.minPrice);
        state.roundPrice = Math.floor(roundPrice * 100) / 100;
        state.targetShares = this.calcSizeForPrice(state.roundPrice);

        await this.placeDualOrders(state);
    }

    private calcSizeForPrice(price: number): number {
        let size = this.tradeShares > 0 ? this.tradeShares : Math.floor(this.tradeSizeUsd / price);
        return Math.max(5, size);
    }

    private async getEffectiveBalance(): Promise<number> {
        if (!this.clobClient) return 0;
        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            return parseFloat((res as any).balance || "0") / 1e6;
        } catch (e) {
            return 0;
        }
    }

    private async placeDualOrders(state: MarketState) {
        if (!this.clobClient) return;

        let size = state.targetShares;
        const price = state.roundPrice;
        const requiredUsd = size * price;

        const balance = await this.getEffectiveBalance();
        if (requiredUsd > balance) {
            const safeUsd = balance * 0.95;
            size = Math.floor(safeUsd / price);
            if (size <= 0) return;
            state.targetShares = size;
        }

        console.log(`[Btc5mDynamicHedge] Posting ${state.slug} Leg-In Limits: YES/NO @ ${price.toFixed(2)} (Size: ${size})`);

        try {
            const yesOrder = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[0],
                price: state.roundPrice,
                side: Side.BUY,
                size: size
            }, { tickSize: "0.01" });
            if (yesOrder?.orderID) {
                state.yesOrderId = yesOrder.orderID;
                this.pnlManager.startCycle(this.COIN, state.marketId, state.slug);
            }
        } catch (e) { }

        try {
            const noOrder = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[1],
                price: state.roundPrice,
                side: Side.BUY,
                size: size
            }, { tickSize: "0.01" });
            if (noOrder?.orderID) {
                state.noOrderId = noOrder.orderID;
                if (!state.yesOrderId) this.pnlManager.startCycle(this.COIN, state.marketId, state.slug);
            }
        } catch (e) { }

        if (state.yesOrderId || state.noOrderId) {
            this.pnlManager.updateCycleCost(state.marketId, state.yesOrderId ? size * price : 0, state.noOrderId ? size * price : 0);
        }
        state.ordersPlaced = true;
    }

    private async cancelOrder(orderId: string) {
        if (!this.clobClient) return;
        try {
            await this.clobClient.cancelOrder({ orderID: orderId });
            console.log(`[Btc5mDynamicHedge] Cancelled Order ${orderId}`);
        } catch (e) { }
    }

    public onPriceUpdate(update: any) {
        const tokenId = update.asset_id;
        const currentPrice = parseFloat(update.price);

        for (const state of this.activeMarkets.values()) {
            if (state.tokenIds.includes(tokenId)) {
                state.prices.set(tokenId, currentPrice);
                const isYes = tokenId === state.tokenIds[0];
                PriceLogger.log(state.slug, tokenId, isYes ? 'YES' : 'NO', currentPrice);
                break;
            }
        }
    }

    private logStatus() {
        if (this.activeMarkets.size === 0) return;

        for (const state of this.activeMarkets.values()) {
            const now = Date.now();
            let timeStr = "";
            let timerColor = COLORS.WHITE;

            if (now < state.startTime) {
                const startsIn = Math.ceil((state.startTime - now) / 1000);
                timeStr = `Starts: ${startsIn}s`;
                timerColor = COLORS.YELLOW;
            } else {
                const endsIn = Math.max(0, Math.ceil((state.endTime - now) / 1000));
                timeStr = `Ends: ${Math.floor(endsIn / 60)}m ${endsIn % 60}s`;
                timerColor = COLORS.GREEN;
            }

            const p1Val = state.prices.get(state.tokenIds[0]);
            const p2Val = state.prices.get(state.tokenIds[1]);
            const p1 = p1Val ? p1Val.toFixed(2) : "?.??";
            const p2 = p2Val ? p2Val.toFixed(2) : "?.??";

            const p1Color = p1Val && p1Val <= state.roundPrice ? COLORS.GREEN : COLORS.WHITE;
            const p2Color = p2Val && p2Val <= state.roundPrice ? COLORS.GREEN : COLORS.WHITE;

            const phaseStr = state.phase === 'HEDGED' ? color("[SECURED]", COLORS.BRIGHT + COLORS.GREEN) :
                             state.phase === 'HEDGE'  ? color("[HUNTING]", COLORS.BRIGHT + COLORS.MAGENTA) :
                             color("[LEG-IN]", COLORS.DIM + COLORS.WHITE);

            const yStatus = state.yesFilled ? color("✅", COLORS.GREEN) : color("⏳", COLORS.YELLOW);
            const nStatus = state.noFilled ? color("✅", COLORS.GREEN) : color("⏳", COLORS.YELLOW);
            const posStr = `[Y:${yStatus} N:${nStatus}]`;

            console.log(
                `${color("[STATUS]", COLORS.CYAN)} ` +
                `${color(timeStr.padEnd(12), timerColor)} | ` +
                `Px: ${color(p1, p1Color)}/${color(p2, p2Color)} | ` +
                `${posStr} ${phaseStr} ${color(state.slug, COLORS.DIM + COLORS.WHITE)}`
            );
        }
    }

    async cleanup(): Promise<void> {
        this.destroyed = true;
        if (this.loopInterval) clearInterval(this.loopInterval);
        if (this.priceSocket) this.priceSocket.close();
        for (const state of this.activeMarkets.values()) {
            await this.handleMarketExpiry(state);
        }
    }
}
