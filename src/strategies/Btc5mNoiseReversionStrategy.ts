import { Strategy } from "./types.js";
import { ClobClient, Side } from "@polymarket/clob-client-v2";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket } from "../clients/websocket.js";
import { WeightedStrategyConfig } from "./BaseWeightedStrategy.js";
import { redeemPositions } from "../scripts/redeem.js";
import { PriceLogger } from "../lib/priceLogger.js";

const COLORS = {
    RESET: "\x1b[0m", BRIGHT: "\x1b[1m", DIM: "\x1b[2m",
    RED: "\x1b[31m", GREEN: "\x1b[32m", YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m", MAGENTA: "\x1b[35m", CYAN: "\x1b[36m", WHITE: "\x1b[37m",
};

function color(text: string, colorCode: string): string {
    return `${colorCode}${text}${COLORS.RESET}`;
}

interface MarketState {
    marketId: string;
    slug: string;
    tokenIds: string[];
    endTime: number;
    startTime: number;
    status: 'ACTIVE' | 'EXPIRED';
    
    yesHistory: number[];
    noHistory: number[];
    
    // Active orders and positions
    yesOrderId?: string;
    noOrderId?: string;
    
    yesLimitOrderPrice: number;
    noLimitOrderPrice: number;
    
    yesPositionShares: number;
    noPositionShares: number;
    
    yesSellOrderId?: string;
    noSellOrderId?: string;
    
    targetSharesYes: number;
    targetSharesNo: number;
}

export class Btc5mNoiseReversionStrategy implements Strategy {
    name = "BTC 5m Noise Reversion (Market Maker)";

    private clobClient?: ClobClient;
    private gammaClient: GammaClient;
    private priceSocket?: PriceSocket;

    private readonly MAX_CONCURRENT = 1;
    private tradeSizeUsd = 2; // Exact $2 constraint from user
    private requiredDrop = 0.12; // Wait for $0.12 drop from MA
    
    private MA_PERIOD = 20; // 20 ticks
    private STOP_LOSS_PRICE = 0.05;
    
    private lastCheckFillsTs = 0;
    private readonly COIN: string;
    private activeMarkets = new Map<string, MarketState>();
    private destroyed = false;
    private loopInterval?: NodeJS.Timeout;

    constructor(config?: Partial<WeightedStrategyConfig>) {
        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));
        this.COIN = (config as any)?.coin || "BTC";
        if (config?.tradeSizeUsd) this.tradeSizeUsd = config.tradeSizeUsd;
    }

    async init(clobClient: ClobClient): Promise<void> {
        this.clobClient = clobClient;
        console.log(`[NoiseReversion] Init: Flash Crash Market Maker ($${this.tradeSizeUsd} per trade, Drop Target: ${this.requiredDrop})`);
    }

    async run(): Promise<void> {
        console.log(color("🔄 Auto-Redeeming previous positions...", COLORS.CYAN));
        try { await redeemPositions(); } catch (e) {}

        this.loopInterval = setInterval(async () => {
            if (this.destroyed) return;
            try { await this.maintenanceLoop(); } catch (e) {
                console.error("[NoiseReversion] Loop Error:", e);
            }
        }, 5000); // 5 sec loop prevents rate limits

        this.findAndJoinMarket();
    }

    private async maintenanceLoop() {
        const now = Date.now();

        for (const [marketId, state] of this.activeMarkets.entries()) {
            if (now >= state.endTime && state.status !== 'EXPIRED') {
                state.status = 'EXPIRED';
                this.handleMarketExpiry(state).then(() => {
                    this.activeMarkets.delete(marketId);
                }).catch(() => this.activeMarkets.delete(marketId));
                continue;
            }

            if (state.status === 'ACTIVE') {
                await this.checkFills(state);
                await this.updateMarketMakerQuotes(state);
            }

            // Connect WS if approaching
            const msToStart = state.startTime - now;
            if (msToStart > 0 && msToStart < 60000 && !this.priceSocket?.isConnected()) {
                console.log(color(`[NoiseReversion] ⚡ Market starting. Connecting WebSocket...`, COLORS.CYAN));
                this.priceSocket?.connect(state.tokenIds);
            }
        }

        const activeCount = Array.from(this.activeMarkets.values()).filter(m => m.status === 'ACTIVE').length;
        if (activeCount === 0) {
            await this.findAndJoinMarket();
        }

        this.logStatus();
    }

    private async updateMarketMakerQuotes(state: MarketState) {
        if (!this.clobClient) return;
        
        // --- YES SIDE LOGIC ---
        if (state.yesHistory.length >= this.MA_PERIOD) {
            const avgYes = state.yesHistory.reduce((a,b) => a+b, 0) / state.yesHistory.length;
            const targetBuy = Math.floor((avgYes - this.requiredDrop) * 100) / 100;
            
            // Only quote if we don't have a position
            if (state.yesPositionShares === 0 && !state.yesSellOrderId) {
                if (targetBuy >= 0.10 && targetBuy <= 0.80) {
                    if (state.yesLimitOrderPrice !== targetBuy) {
                        if (state.yesOrderId) await this.cancelOrder(state.yesOrderId);
                        
                        let shares = this.tradeSizeUsd / targetBuy;
                        if (shares < 5) shares = 5; // Enforce minimums
                        // Round up to nearest integer to avoid precision issues
                        shares = Math.ceil(shares);
                        
                        try {
                            const o = await this.clobClient.createAndPostOrder({
                                tokenID: state.tokenIds[0], price: targetBuy, side: Side.BUY, size: shares
                            }, { tickSize: "0.01" });
                            if (o?.orderID) {
                                state.yesOrderId = o.orderID;
                                state.yesLimitOrderPrice = targetBuy;
                                state.targetSharesYes = shares;
                            }
                        } catch(e){}
                    }
                } else if (state.yesOrderId) {
                    // Out of bounds, cancel order
                    await this.cancelOrder(state.yesOrderId);
                    state.yesOrderId = undefined;
                    state.yesLimitOrderPrice = 0;
                }
            } else if (state.yesPositionShares > 0 && state.yesSellOrderId) {
                // We have a sell order open. Check Stop Loss!
                const currentYes = state.yesHistory[state.yesHistory.length - 1];
                if (currentYes <= this.STOP_LOSS_PRICE) {
                    console.log(color(`[NoiseReversion] 🚨 STOP LOSS TRIGGERED ON YES! Dumping at ${this.STOP_LOSS_PRICE}`, COLORS.RED));
                    await this.cancelOrder(state.yesSellOrderId);
                    state.yesSellOrderId = undefined;
                    
                    try {
                        const dump = await this.clobClient.createAndPostOrder({
                            tokenID: state.tokenIds[0], price: 0.01, side: Side.SELL, size: state.yesPositionShares
                        }, { tickSize: "0.01" });
                        state.yesSellOrderId = dump?.orderID;
                    } catch(e){}
                }
            }
        }
        
        // --- NO SIDE LOGIC ---
        if (state.noHistory.length >= this.MA_PERIOD) {
            const avgNo = state.noHistory.reduce((a,b) => a+b, 0) / state.noHistory.length;
            const targetBuyNo = Math.floor((avgNo - this.requiredDrop) * 100) / 100;
            
            if (state.noPositionShares === 0 && !state.noSellOrderId) {
                if (targetBuyNo >= 0.10 && targetBuyNo <= 0.80) {
                    if (state.noLimitOrderPrice !== targetBuyNo) {
                        if (state.noOrderId) await this.cancelOrder(state.noOrderId);
                        
                        let shares = this.tradeSizeUsd / targetBuyNo;
                        if (shares < 5) shares = 5;
                        shares = Math.ceil(shares);
                        
                        try {
                            const o = await this.clobClient.createAndPostOrder({
                                tokenID: state.tokenIds[1], price: targetBuyNo, side: Side.BUY, size: shares
                            }, { tickSize: "0.01" });
                            if (o?.orderID) {
                                state.noOrderId = o.orderID;
                                state.noLimitOrderPrice = targetBuyNo;
                                state.targetSharesNo = shares;
                            }
                        } catch(e){}
                    }
                } else if (state.noOrderId) {
                    await this.cancelOrder(state.noOrderId);
                    state.noOrderId = undefined;
                    state.noLimitOrderPrice = 0;
                }
            } else if (state.noPositionShares > 0 && state.noSellOrderId) {
                const currentNo = state.noHistory[state.noHistory.length - 1];
                if (currentNo <= this.STOP_LOSS_PRICE) {
                    console.log(color(`[NoiseReversion] 🚨 STOP LOSS TRIGGERED ON NO! Dumping at ${this.STOP_LOSS_PRICE}`, COLORS.RED));
                    await this.cancelOrder(state.noSellOrderId);
                    state.noSellOrderId = undefined;
                    try {
                        const dump = await this.clobClient.createAndPostOrder({
                            tokenID: state.tokenIds[1], price: 0.01, side: Side.SELL, size: state.noPositionShares
                        }, { tickSize: "0.01" });
                        state.noSellOrderId = dump?.orderID;
                    } catch(e){}
                }
            }
        }
    }

    private async checkFills(state: MarketState) {
        if (!this.clobClient) return;
        const promises = [];

        // Check if Entry YES filled
        if (state.yesOrderId && state.yesPositionShares === 0) {
            promises.push((async () => {
                try {
                    const order = await this.clobClient!.getOrder(state.yesOrderId!);
                    // @ts-ignore
                    if (order && (order.status === "MATCHED" || order.status === "FILLED")) {
                        // @ts-ignore
                        state.yesPositionShares = parseFloat(order.size_matched);
                        console.log(color(`[NoiseReversion] 🎣 YES Dip Caught @ ${state.yesLimitOrderPrice}! (Shares: ${state.yesPositionShares})`, COLORS.GREEN));
                        
                        state.yesOrderId = undefined;
                        // Instantly place Sell order at MA
                        const avgYes = state.yesHistory.reduce((a,b) => a+b, 0) / state.yesHistory.length;
                        const targetSell = Math.floor(avgYes * 100) / 100;
                        const o = await this.clobClient!.createAndPostOrder({
                            tokenID: state.tokenIds[0], price: targetSell, side: Side.SELL, size: state.yesPositionShares
                        }, { tickSize: "0.01" });
                        state.yesSellOrderId = o?.orderID;
                    }
                } catch(e){}
            })());
        }

        // Check if Entry NO filled
        if (state.noOrderId && state.noPositionShares === 0) {
            promises.push((async () => {
                try {
                    const order = await this.clobClient!.getOrder(state.noOrderId!);
                    // @ts-ignore
                    if (order && (order.status === "MATCHED" || order.status === "FILLED")) {
                        // @ts-ignore
                        state.noPositionShares = parseFloat(order.size_matched);
                        console.log(color(`[NoiseReversion] 🎣 NO Dip Caught @ ${state.noLimitOrderPrice}!`, COLORS.GREEN));
                        state.noOrderId = undefined;
                        
                        const avgNo = state.noHistory.reduce((a,b) => a+b, 0) / state.noHistory.length;
                        const targetSell = Math.floor(avgNo * 100) / 100;
                        const o = await this.clobClient!.createAndPostOrder({
                            tokenID: state.tokenIds[1], price: targetSell, side: Side.SELL, size: state.noPositionShares
                        }, { tickSize: "0.01" });
                        state.noSellOrderId = o?.orderID;
                    }
                } catch(e){}
            })());
        }

        // Check if Exit YES filled
        if (state.yesSellOrderId && state.yesPositionShares > 0) {
            promises.push((async () => {
                try {
                    const order = await this.clobClient!.getOrder(state.yesSellOrderId!);
                    // @ts-ignore
                    if (order && (order.status === "MATCHED" || order.status === "FILLED")) {
                        console.log(color(`[NoiseReversion] 💰 YES Reversion Secured! Profit Locked.`, COLORS.BRIGHT + COLORS.CYAN));
                        state.yesPositionShares = 0;
                        state.yesSellOrderId = undefined;
                        state.yesLimitOrderPrice = 0; // ready to quote again
                    }
                } catch(e){}
            })());
        }

        // Check if Exit NO filled
        if (state.noSellOrderId && state.noPositionShares > 0) {
            promises.push((async () => {
                try {
                    const order = await this.clobClient!.getOrder(state.noSellOrderId!);
                    // @ts-ignore
                    if (order && (order.status === "MATCHED" || order.status === "FILLED")) {
                        console.log(color(`[NoiseReversion] 💰 NO Reversion Secured! Profit Locked.`, COLORS.BRIGHT + COLORS.CYAN));
                        state.noPositionShares = 0;
                        state.noSellOrderId = undefined;
                        state.noLimitOrderPrice = 0;
                    }
                } catch(e){}
            })());
        }

        if (promises.length > 0) await Promise.allSettled(promises);
    }

    private async cancelOrder(id: string) {
        try { await this.clobClient!.cancelOrder({ orderID: id }); } catch (e) {}
    }

    public onPriceUpdate(u: any) {
        const tokenId = u.asset_id;
        const currentPrice = parseFloat(u.price);

        for (const s of this.activeMarkets.values()) {
            if (s.tokenIds.includes(tokenId)) {
                const isYes = tokenId === s.tokenIds[0];
                if (isYes) {
                    s.yesHistory.push(currentPrice);
                    if (s.yesHistory.length > this.MA_PERIOD) s.yesHistory.shift();
                } else {
                    s.noHistory.push(currentPrice);
                    if (s.noHistory.length > this.MA_PERIOD) s.noHistory.shift();
                }
                PriceLogger.log(s.slug, tokenId, isYes ? 'YES' : 'NO', currentPrice);
                break;
            }
        }
    }

    private logStatus() {
        if (this.activeMarkets.size === 0) return;
        for (const s of this.activeMarkets.values()) {
            const now = Date.now();
            let timeStr = now < s.startTime ? `Starts: ${Math.ceil((s.startTime - now) / 1000)}s` : `Ends: Math.ceil(${(s.endTime - now) / 1000}s)`;
            
            const p1 = s.yesHistory.length > 0 ? s.yesHistory[s.yesHistory.length - 1].toFixed(2) : "?.??";
            const p2 = s.noHistory.length > 0 ? s.noHistory[s.noHistory.length - 1].toFixed(2) : "?.??";

            const yStatus = s.yesPositionShares > 0 
                ? color(`🟢 HOLD (${s.yesPositionShares}s)`, COLORS.GREEN) 
                : (s.yesOrderId ? color(`⏳ BID ($${s.yesLimitOrderPrice})`, COLORS.YELLOW) : "⚪ IDLE");
            const nStatus = s.noPositionShares > 0 
                ? color(`🟢 HOLD (${s.noPositionShares}s)`, COLORS.GREEN) 
                : (s.noOrderId ? color(`⏳ BID ($${s.noLimitOrderPrice})`, COLORS.YELLOW) : "⚪ IDLE");

            console.log(
                `${color("[REVERSION]", COLORS.YELLOW)} | Px: ${color(p1, COLORS.GREEN)}/${color(p2, COLORS.RED)} | ` +
                `Y: ${yStatus} | N: ${nStatus} | ` +
                color(s.slug, COLORS.DIM + COLORS.WHITE)
            );
        }
    }

    private async findAndJoinMarket() {
        const nowSec = Math.floor(Date.now() / 1000);
        const interval = 300;
        const currentSlot = Math.floor(nowSec / interval) * interval;
        
        // Find current or upcoming
        for (let i = 0; i < 3; i++) {
            const ts = currentSlot + (i * interval);
            const slug = `${this.COIN.toLowerCase()}-updown-5m-${ts}`;
            if (Array.from(this.activeMarkets.values()).some(m => m.slug === slug)) continue;

            try {
                const results = await this.gammaClient.getMarkets(`slug=${slug}`);
                if (results && results.length > 0) {
                    const m = results[0];
                    if (m.closed || m.slug !== slug) continue;
                    
                    const endTime = (ts + interval) * 1000;
                    if (endTime - Date.now() < 30000) continue; // too close to end

                    await this.joinMarket(m, ts * 1000, endTime);
                    break;
                }
            } catch(e){}
        }
    }

    private async joinMarket(m: any, start: number, end: number) {
        let tokenIds: string[] = [];
        try { tokenIds = JSON.parse(m.clobTokenIds); } catch (e) { return; }

        const state: MarketState = {
            marketId: m.id, slug: m.slug, tokenIds, endTime: end, startTime: start,
            status: 'ACTIVE', yesHistory: [], noHistory: [],
            yesLimitOrderPrice: 0, noLimitOrderPrice: 0,
            yesPositionShares: 0, noPositionShares: 0,
            targetSharesYes: 0, targetSharesNo: 0
        };

        this.activeMarkets.set(m.id, state);
        
        const msToStart = start - Date.now();
        if (this.priceSocket) {
            if (msToStart < 1800000) { // 30 minutes
                if (this.priceSocket.isConnected()) this.priceSocket.subscribe(tokenIds);
                else this.priceSocket.connect(tokenIds);
            }
        }
    }

    private async handleMarketExpiry(state: MarketState) {
        if (state.yesOrderId) await this.cancelOrder(state.yesOrderId);
        if (state.noOrderId) await this.cancelOrder(state.noOrderId);
        if (state.yesSellOrderId) await this.cancelOrder(state.yesSellOrderId);
        if (state.noSellOrderId) await this.cancelOrder(state.noSellOrderId);

        if (this.priceSocket) this.priceSocket.unsubscribe(state.tokenIds);
        await redeemPositions();
    }

    async cleanup() {
        if (this.loopInterval) clearInterval(this.loopInterval);
        if (this.priceSocket) this.priceSocket.close();
    }
}
