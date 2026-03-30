import { Strategy } from "./types.js";
import { ClobClient, Side, OrderType, AssetType } from "@polymarket/clob-client";
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
    phase: 'WICK_HUNT' | 'DRIFT' | 'SECURED';
    hedgeSide?: 'YES' | 'NO';
    hedgeOrderId?: string;
    hedgeTargetPrice?: number;
    unwindTriggered: boolean;
    cycleCount: number;      // [NEW] Recursive tracking
    lastSecuredTs?: number;  // [NEW] Cooldown tracking
}

export class Btc5mWickDriftStrategy implements Strategy {
    name = "BTC 5m Wick Hunter & Drift Strategy";

    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket?: PriceSocket;
    private pnlManager: PnlManager;

    private readonly MAX_CONCURRENT = 1;
    private readonly MAX_CYCLES_PER_MARKET = 3; // [NEW] Stop after X snipes
    private tradeSizeUsd = 20;
    private tradeShares = 0;
    private minPrice = 0.35;
    private maxPrice = 0.35;
    
    // NEW Strategy Params
    private targetProfitUsd = 0.15; // Aim for $0.15 profit per share
    private wickOffsetPct = 0.15; // Limit order at MidPoint - 15%
    
    private lastCheckFillsTs = 0;
    private COOLDOWN_MS = 10 * 60 * 1000;
    private readonly COIN = "BTC";

    private activeMarkets = new Map<string, MarketState>();
    private cooldownUntil: number | null = null;
    private consecutiveFailures = 0;
    private destroyed = false;

    private loopInterval?: NodeJS.Timeout;

    constructor(config?: Partial<DipArbConfig>) {
        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));
        this.pnlManager = new PnlManager();

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
    }

    async init(clobClient: ClobClient): Promise<void> {
        this.clobClient = clobClient;
        const sizeDesc = this.tradeShares > 0 ? `${this.tradeShares} shares` : `$${this.tradeSizeUsd}/side`;
        console.log(`[WickDrift] Init: Hunter Mode (Target Profit: $${this.targetProfitUsd} per share)`);
    }

    async run(): Promise<void> {
        console.log(color("🔄 Performing initial Auto-Redeem...", COLORS.CYAN));
        try {
            await redeemPositions();
        } catch (e) {}

        this.loopInterval = setInterval(async () => {
            if (this.destroyed) return;
            try {
                await this.maintenanceLoop();
            } catch (e) {
                console.error("[WickDrift] Loop Error:", e);
            }
        }, 5000);

        this.findAndJoinMarket();
    }

    private async maintenanceLoop() {
        const now = Date.now();

        if (this.cooldownUntil && now < this.cooldownUntil) return;
        else if (this.cooldownUntil && now >= this.cooldownUntil) {
            this.cooldownUntil = null;
            this.consecutiveFailures = 0;
        }

        let minTimeLeft = Infinity;
        for (const [marketId, state] of this.activeMarkets.entries()) {
            if (now >= state.endTime && state.status !== 'EXPIRED') {
                state.status = 'EXPIRED';
                this.handleMarketExpiry(state).then(() => {
                    this.activeMarkets.delete(marketId);
                }).catch(() => this.activeMarkets.delete(marketId));
                continue;
            }

            if (state.status === 'ACTIVE') {
                const timeLeft = Math.max(0, (state.endTime - now) / 1000);
                if (timeLeft < minTimeLeft) minTimeLeft = timeLeft;

                // Handle Drift & Unwind
                if (state.phase === 'DRIFT') {
                    await this.manageDriftPhase(state, timeLeft);
                }
            }

            if (state.ordersPlaced && state.status === 'ACTIVE') {
                await this.checkFills(state);
            }

            // [NEW] Delayed WebSocket Connection Trigger (1 min before start)
            const msToStart = state.startTime - now;
            if (msToStart > 0 && msToStart < 60000 && !this.priceSocket?.isConnected()) {
                console.log(color(`[WickDrift] ⚡ Market starting in ${Math.round(msToStart/1000)}s. Connecting WebSocket Swarm...`, COLORS.CYAN));
                this.priceSocket?.connect(state.tokenIds);
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

    private async manageDriftPhase(state: MarketState, timeLeftSeconds: number) {
        if (!state.hedgeOrderId || !state.hedgeTargetPrice) return;
        
        // UNWIND LOGIC: Final 60 seconds
        if (timeLeftSeconds < 60 && !state.unwindTriggered) {
            state.unwindTriggered = true;
            console.log(color(`[WickDrift] ⚠️ Final minute reached for ${state.slug}. Switching to AGGRESSIVE HEDGE.`, COLORS.YELLOW));
        }

        if (state.unwindTriggered) {
            // Aggressively move the hedge bid towards current mid to break-even
            const mid = state.prices.get(state.tokenIds[state.hedgeSide === 'YES' ? 0 : 1]) || 0;
            if (mid > 0) {
                // Aim for break-even cost (1.00 - leg1 cost)
                let breakEvenPrice = 0.99 - state.roundPrice;
                if (breakEvenPrice < 0.05) breakEvenPrice = 0.05;

                // If currently bidding too low, move it up
                if (state.hedgeTargetPrice < breakEvenPrice - 0.02) {
                    await this.cancelOrder(state.hedgeOrderId);
                    state.hedgeTargetPrice = breakEvenPrice;
                    state.hedgeOrderId = undefined;
                    
                    const tokenIdx = state.hedgeSide === 'YES' ? 0 : 1;
                    const hOrder = await this.clobClient!.createAndPostOrder({
                        tokenID: state.tokenIds[tokenIdx],
                        price: state.hedgeTargetPrice,
                        side: Side.BUY, size: state.targetShares
                    }, { tickSize: "0.01" });
                    
                    if (hOrder?.orderID) state.hedgeOrderId = hOrder.orderID;
                }
            }
        }
    }

    private async checkFills(state: MarketState) {
        if (!this.clobClient) return;
        const now = Date.now();
        if (now - this.lastCheckFillsTs < 3000) return;
        this.lastCheckFillsTs = now;

        const promises = [];

        if (state.phase === 'WICK_HUNT') {
            if (state.yesOrderId && !state.yesFilled) {
                promises.push((async () => {
                    try {
                        const order = await this.clobClient!.getOrder(state.yesOrderId!);
                        // @ts-ignore
                        if (order && (order.status === "MATCHED" || order.status === "FILLED" || parseFloat(order.size_matched) >= state.targetShares)) {
                            state.yesFilled = true;
                            console.log(color(`[WickDrift] 🏹 YES Wick Caught! Leg-In complete for ${state.slug}`, COLORS.BRIGHT + COLORS.GREEN));
                            await this.startDriftHedge(state, 'NO');
                        }
                    } catch (e: any) {}
                })());
            }
            if (state.noOrderId && !state.noFilled) {
                promises.push((async () => {
                    try {
                        const order = await this.clobClient!.getOrder(state.noOrderId!);
                        // @ts-ignore
                        if (order && (order.status === "MATCHED" || order.status === "FILLED" || parseFloat(order.size_matched) >= state.targetShares)) {
                            state.noFilled = true;
                            console.log(color(`[WickDrift] 🏹 NO Wick Caught! Leg-In complete for ${state.slug}`, COLORS.BRIGHT + COLORS.GREEN));
                            if (!state.yesFilled) await this.startDriftHedge(state, 'YES');
                        }
                    } catch (e: any) {}
                })());
            }
        } else if (state.phase === 'DRIFT') {
            if (state.hedgeOrderId && (!state.yesFilled || !state.noFilled)) {
                promises.push((async () => {
                    try {
                        const order = await this.clobClient!.getOrder(state.hedgeOrderId!);
                        // @ts-ignore
                        if (order && (order.status === "MATCHED" || order.status === "FILLED" || parseFloat(order.size_matched) >= state.targetShares)) {
                            if (state.hedgeSide === 'YES') state.yesFilled = true;
                            else state.noFilled = true;
                            state.phase = 'SECURED';
                            state.lastSecuredTs = Date.now(); // [NEW] Start re-entry timer
                            console.log(color(`[WickDrift] 💰 DRIFT COMPLETED! Hedge secured at $${state.hedgeTargetPrice} (Profit Plan: +$${this.targetProfitUsd})`, COLORS.BRIGHT + COLORS.CYAN));
                        }
                    } catch (e: any) {}
                })());
            }
        } else if (state.phase === 'SECURED') {
            // [NEW] Recursive Re-entry logic
            const timeLeft = Math.max(0, (state.endTime - Date.now()) / 1000);
            if (timeLeft > 150 && state.cycleCount < this.MAX_CYCLES_PER_MARKET) {
                const waitElapsed = (Date.now() - (state.lastSecuredTs || 0)) / 1000;
                if (waitElapsed > 10) { // 10s Jitter
                    console.log(color(`[WickDrift] 🔄 Market ${state.slug} has ${timeLeft.toFixed(0)}s left. RESETTING FOR CYCLE ${state.cycleCount + 1}...`, COLORS.BRIGHT + COLORS.MAGENTA));
                    
                    state.phase = 'WICK_HUNT';
                    state.yesFilled = false;
                    state.noFilled = false;
                    state.ordersPlaced = false;
                    state.yesOrderId = undefined;
                    state.noOrderId = undefined;
                    state.hedgeOrderId = undefined;
                    state.hedgeSide = undefined;
                    state.unwindTriggered = false;
                    state.cycleCount++;

                    // Re-calculate hunter price based on NEW midpoint
                    const mid = state.prices.get(state.tokenIds[0]) || 0.50;
                    state.roundPrice = Math.floor((mid * (1 - this.wickOffsetPct)) * 100) / 100;

                    this.placeLegInOrders(state).catch(e => console.error("[WickDrift] Re-entry failed:", e));
                }
            }
        }

        if (promises.length > 0) await Promise.allSettled(promises);
    }

    private async startDriftHedge(state: MarketState, hedgeSide: 'YES' | 'NO') {
        state.phase = 'DRIFT';
        state.hedgeSide = hedgeSide;
        
        // Cancel the other resting leg-in
        if (hedgeSide === 'NO' && state.noOrderId) { await this.cancelOrder(state.noOrderId); state.noOrderId = undefined; }
        if (hedgeSide === 'YES' && state.yesOrderId) { await this.cancelOrder(state.yesOrderId); state.yesOrderId = undefined; }

        // DRIFT TARGET: Total cost = 1.00 - targetProfitUsd
        const costAlreadyPaid = state.roundPrice;
        let driftTarget = (1.0 - this.targetProfitUsd) - costAlreadyPaid;
        
        if (driftTarget > 0.99) driftTarget = 0.99;
        if (driftTarget < 0.05) driftTarget = 0.05;
        
        state.hedgeTargetPrice = Math.floor(driftTarget * 100) / 100;

        console.log(color(`[WickDrift] ⏳ Drift Target Set: ${hedgeSide} @ ${state.hedgeTargetPrice}. Waiting for market movement...`, COLORS.MAGENTA));

        const tokenIdx = hedgeSide === 'YES' ? 0 : 1;
        try {
            const hOrder = await this.clobClient!.createAndPostOrder({
                tokenID: state.tokenIds[tokenIdx],
                price: state.hedgeTargetPrice,
                side: Side.BUY, size: state.targetShares
            }, { tickSize: "0.01" });
            if (hOrder?.orderID) state.hedgeOrderId = hOrder.orderID;
        } catch (e) {}
    }

    private async handleMarketExpiry(state: MarketState) {
        if (state.yesOrderId && !state.yesFilled) await this.cancelOrder(state.yesOrderId);
        if (state.noOrderId && !state.noFilled) await this.cancelOrder(state.noOrderId);
        if (state.hedgeOrderId && state.phase === 'DRIFT') await this.cancelOrder(state.hedgeOrderId);

        let res = "NEUTRAL";
        if (state.yesFilled && state.noFilled) res = "SUCCESS";
        else if (state.yesFilled || state.noFilled) {
            res = "PARTIAL";
            this.consecutiveFailures++;
        }

        console.log(`[WickDrift] Round ${state.slug} over. Outcome: ${res}`);
        
        if (res === 'SUCCESS') {
            const profit = (state.targetShares * 1.0) - (state.targetShares * state.roundPrice) - (state.targetShares * (state.hedgeTargetPrice || 0));
            this.pnlManager.closeCycle(state.marketId, 'WIN', profit);
        } else if (res === 'PARTIAL') {
            this.pnlManager.closeCycle(state.marketId, 'LOSS', -(state.targetShares * state.roundPrice));
            this.consecutiveFailures++;
        } else {
            this.pnlManager.closeCycle(state.marketId, 'EXPIRED', 0);
        }

        // [NEW] Unsubscribe from expired tokens to keep the swarm lean
        if (this.priceSocket) {
            this.priceSocket.unsubscribe(state.tokenIds);
        }

        await redeemPositions();
        
        if (this.consecutiveFailures >= 2) {
            this.cooldownUntil = Date.now() + this.COOLDOWN_MS;
        }
    }

    private async findAndJoinMarket() {
        if (this.cooldownUntil) return;
        const nowSec = Math.floor(Date.now() / 1000);
        const interval = 300;
        const currentSlot = Math.floor(nowSec / interval) * interval;
        const maxLookahead = 8; // [NEW] Look 40 mins ahead

        for (let i = 0; i < maxLookahead; i++) {
            const ts = currentSlot + (i * interval);
            const slug = `${this.COIN.toLowerCase()}-updown-5m-${ts}`;
            if (Array.from(this.activeMarkets.values()).some(m => m.slug === slug)) continue;

            try {
                const results = await this.gammaClient.getMarkets(`slug=${slug}`);
                if (results && results.length > 0) {
                    const m = results[0];
                    if (m.closed || m.slug !== slug) continue;
                    
                    const endTime = (ts + interval) * 1000;
                    const timeLeft = endTime - Date.now();
                    if (timeLeft < 270000 || Date.now() >= endTime - 30000) continue;

                    await this.joinMarket(m, ts * 1000, endTime);
                    break;
                }
            } catch (e) {}
        }
    }

    private async joinMarket(m: any, start: number, end: number) {
        let tokenIds: string[] = [];
        try { tokenIds = JSON.parse(m.clobTokenIds); } catch (e) { return; }

        const state: MarketState = {
            marketId: m.id, slug: m.slug, tokenIds, endTime: end, startTime: start,
            yesFilled: false, noFilled: false, ordersPlaced: false, prices: new Map(),
            status: 'ACTIVE', targetShares: 0, roundPrice: 0, 
            phase: 'WICK_HUNT', unwindTriggered: false, cycleCount: 1
        };

        this.activeMarkets.set(m.id, state);
        
        // [NEW] Hot-Subscribe to future markets up to 30 minutes early
        const msToStart = start - Date.now();
        if (this.priceSocket) {
            if (msToStart < 1800000) { // 30 minutes
                console.log(color(`[WickDrift] 🔥 Hot-Subscribing to ${state.slug} (${Math.round(msToStart/60000)}m until start)`, COLORS.CYAN));
                if (this.priceSocket.isConnected()) {
                    this.priceSocket.subscribe(tokenIds);
                } else {
                    this.priceSocket.connect(tokenIds);
                }
            } else {
                console.log(color(`[WickDrift] 💤 Market ${state.slug} starts in ${Math.round(msToStart/60000)}m. Subscription deferred.`, COLORS.DIM + COLORS.WHITE));
            }
        }

        // SEED PRICES
        try {
            const [mid1, mid2] = await Promise.all([
                this.clobClient!.getMidpoint(tokenIds[0]),
                this.clobClient!.getMidpoint(tokenIds[1])
            ]);
            if (mid1?.mid) state.prices.set(tokenIds[0], parseFloat(mid1.mid));
            if (mid2?.mid) state.prices.set(tokenIds[1], parseFloat(mid2.mid));
        } catch (e) {}

        // WICK TARGETING: Place orders deep (Mid - offset)
        const avgMid = 0.50; // Assume 0.50 if mid fetching failed
        let mid = state.prices.get(tokenIds[0]) || avgMid;
        
        // If user provided a fixed price via --price, use it as the "Wick" buy level
        let hunterPrice = this.minPrice;
        if (this.minPrice === 0.35) { // If default, try to be dynamic
            hunterPrice = mid * (1 - this.wickOffsetPct);
        }
        
        state.roundPrice = Math.floor(hunterPrice * 100) / 100;
        state.targetShares = Math.max(5, this.tradeShares > 0 ? this.tradeShares : Math.floor(this.tradeSizeUsd / state.roundPrice));

        await this.placeLegInOrders(state);
    }

    private async placeLegInOrders(state: MarketState) {
        if (!this.clobClient) return;
        const size = state.targetShares;
        const p = state.roundPrice;

        console.log(`[WickDrift] 🎯 Hunting Wicks: ${state.slug} Buy YES/NO @ ${p.toFixed(2)} (Shares: ${size})`);

        try {
            const yes = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[0], price: p, side: Side.BUY, size
            }, { tickSize: "0.01" });
            if (yes?.orderID) {
                state.yesOrderId = yes.orderID;
                this.pnlManager.startCycle(this.COIN, state.marketId, state.slug);
            }
        } catch (e) {}
        try {
            const no = await this.clobClient.createAndPostOrder({
                tokenID: state.tokenIds[1], price: p, side: Side.BUY, size
            }, { tickSize: "0.01" });
            if (no?.orderID) {
                state.noOrderId = no.orderID;
                if (!state.yesOrderId) this.pnlManager.startCycle(this.COIN, state.marketId, state.slug);
            }
        } catch (e) {}

        if (state.yesOrderId || state.noOrderId) {
            this.pnlManager.updateCycleCost(state.marketId, state.yesOrderId ? size * p : 0, state.noOrderId ? size * p : 0);
        }
        state.ordersPlaced = true;
    }

    private async cancelOrder(id: string) {
        try { await this.clobClient!.cancelOrder({ orderID: id }); } catch (e) {}
    }

    public onPriceUpdate(u: any) {
        const tokenId = u.asset_id;
        const currentPrice = parseFloat(u.price);

        for (const s of this.activeMarkets.values()) {
            if (s.tokenIds.includes(tokenId)) {
                s.prices.set(tokenId, currentPrice);
                const isYes = tokenId === s.tokenIds[0];
                PriceLogger.log(s.slug, tokenId, isYes ? 'YES' : 'NO', currentPrice);
                break;
            }
        }
    }

    private logStatus() {
        if (this.activeMarkets.size === 0) return;
        for (const s of this.activeMarkets.values()) {
            const now = Date.now();
            
            let timeStr = "";
            let timerColor = COLORS.WHITE;

            if (now < s.startTime) {
                const startsIn = Math.ceil((s.startTime - now) / 1000);
                timeStr = `Starts: ${startsIn}s`;
                timerColor = COLORS.YELLOW;
            } else {
                const endsIn = Math.max(0, Math.ceil((s.endTime - now) / 1000));
                timeStr = `Ends: ${Math.floor(endsIn / 60)}m ${endsIn % 60}s`;
                timerColor = COLORS.GREEN;
            }

            const p1Val = s.prices.get(s.tokenIds[0]);
            const p2Val = s.prices.get(s.tokenIds[1]);
            const p1 = p1Val ? p1Val.toFixed(2) : "?.??";
            const p2 = p2Val ? p2Val.toFixed(2) : "?.??";

            const p1Color = p1Val && p1Val <= s.roundPrice ? COLORS.GREEN : COLORS.WHITE;
            const p2Color = p2Val && p2Val <= s.roundPrice ? COLORS.GREEN : COLORS.WHITE;

            let phaseStr = s.phase === 'SECURED' ? color("[SECURED]", COLORS.BRIGHT + COLORS.CYAN) :
                             s.phase === 'DRIFT'   ? color("[DRIFTING]", COLORS.MAGENTA) :
                             color("[HUNTING]", COLORS.GREEN);
            if (s.unwindTriggered && s.phase === 'DRIFT') phaseStr = color("[UNWIND!]", COLORS.RED);

            const yStatus = s.yesFilled ? color("✅", COLORS.GREEN) : color("⏳", COLORS.YELLOW);
            const nStatus = s.noFilled ? color("✅", COLORS.GREEN) : color("⏳", COLORS.YELLOW);
            const posStr = `[Y:${yStatus} N:${nStatus}]`;

            console.log(
                `${color("[STATUS]", COLORS.CYAN)} ` +
                `${color(timeStr.padEnd(12), timerColor)} | ` +
                `Cy: ${color(s.cycleCount.toString(), COLORS.WHITE)} | ` +
                `Px: ${color(p1, p1Color)}/${color(p2, p2Color)} | ` +
                `${posStr} ${phaseStr} ` +
                color(s.slug, COLORS.DIM + COLORS.WHITE)
            );
        }
    }

    async cleanup() {
        if (this.loopInterval) clearInterval(this.loopInterval);
        if (this.priceSocket) this.priceSocket.close();
    }
}
