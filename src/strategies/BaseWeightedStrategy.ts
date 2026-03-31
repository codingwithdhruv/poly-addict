import { Strategy } from "./types.js";
import { ClobClient, Side, AssetType } from "@polymarket/clob-client";
import { GammaClient } from "../clients/gamma-api.js";
import { PriceSocket, PriceUpdate } from "../clients/websocket.js";
import { PnlManager } from "../lib/pnlManager.js";
import { WalletGuard } from "../lib/walletGuard.js";
import { redeemPositions } from "../scripts/redeem.js";
import { CONFIG } from "../clients/config.js";
import { ethers } from "ethers";
import { PriceLogger } from "../lib/priceLogger.js";

// --- UI / ANSI Helpers ---
export const COLORS = {
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
    BG_RED: "\x1b[41m",
    BG_GREEN: "\x1b[42m",
};

export function color(text: string, colorCode: string): string {
    return `${colorCode}${text}${COLORS.RESET}`;
}

export function box(lines: string[], colorCode: string = COLORS.CYAN): void {
    const width = Math.max(...lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').length)) + 4;
    const top = `╔${"═".repeat(width - 2)}╗`;
    const bot = `╚${"═".repeat(width - 2)}╝`;

    console.log(colorCode + top + COLORS.RESET);
    lines.forEach(l => {
        const visibleLen = l.replace(/\x1b\[[0-9;]*m/g, '').length;
        const padding = " ".repeat(width - 4 - visibleLen);
        console.log(`${colorCode}║ ${COLORS.RESET} ${l}${padding} ${colorCode}║${COLORS.RESET}`);
    });
    console.log(colorCode + bot + COLORS.RESET);
}

// --- Interfaces ---

export interface PricePoint {
    price: number;
    timestamp: number;
}

export interface SideState {
    totalShares: number;
    totalCost: number; // Sum of (price * shares)
    avgPrice: number;  // totalCost / totalShares
    buysTriggered: number;
    lastBuyPrice?: number;
    isBuying: boolean;
    lastBuyTs: number;
    firstBuyTs: number;
}

export interface MarketState {
    marketId: string;
    tokenIds: string[]; // [YesToken, NoToken]
    prices: Map<string, PricePoint[]>; 
    position: {
        yes: SideState; 
        no: SideState;  
    };
    tokenIdToSide: Map<string, 'yes' | 'no'>;
    status: 'scanning' | 'complete' | 'exiting' | 'partial_unwind' | 'pre-warming';
    endTime: number;
    startTime: number;
    slug: string;
    question: string;
    bestPairCost: number;       
    lastImproveTs: number;      
    maxMarketUsd: number;
    stats: {
        signalsDetected: number;
    };
    arbLocked?: boolean;
}

export interface MakerBiasConfig {
    enabled: boolean;
    minPrice: number;       
    maxPrice: number;       
    passiveFirst: boolean;  
    fallbackMs: number;     
}

export interface EarlyExitConfig {
    enabled: boolean;
    minProfitPct: number;   
    minProfitUsd: number;   
    maxSlippagePct: number; 
}

export interface LateExitConfig {
    enabled: boolean;
    timeRemainingSeconds: number;
    minWinnerPrice: number;       
    minProfitUsd: number;         
}

export interface PartialUnwindConfig {
    enabled: boolean;
    timeRemainingSeconds: number; 
    minWinnerPrice: number;       
    minProfitUsd: number;         
}

export interface WeightedStrategyConfig {
    coin: string;
    duration: '5m' | '15m';
    dipThreshold: number;      
    slidingWindowMs: number;
    sumTarget: number;
    shares: number;
    leg2TimeoutSeconds: number;
    ignorePriceBelow?: number;
    verbose?: boolean;
    info?: boolean;
    redeem?: boolean;
    dashboard?: boolean;
    minExpectedProfit?: number; 
    makerBias?: MakerBiasConfig; 
    earlyExit?: EarlyExitConfig;
    lateExit?: LateExitConfig;
    partialUnwind?: PartialUnwindConfig;
    // Strategy Specific (Extreme/Hedge)
    tradeSizeUsd?: number;
    limitPrice?: string | number;
    side?: 'YES' | 'NO' | 'BOTH';
    cooldownMinutes?: number;
    strategy?: string;
}

/**
 * BaseWeightedStrategy
 * Core engine for all weighted-average and dip/arb strategies.
 * Provides consistent risk management, exit logic, and concurrency safety.
 */
export abstract class BaseWeightedStrategy implements Strategy {
    abstract name: string;
    protected clobClient?: ClobClient;
    protected gammaClient: GammaClient;
    protected priceSocket: PriceSocket;
    protected pnlManager: PnlManager;
    protected config: WeightedStrategyConfig;
    protected activeMarkets: Map<string, MarketState> = new Map();
    protected statusInterval?: NodeJS.Timeout;
    
    private processingTokens: Set<string> = new Set();
    protected nextMarketLoaded = false;

    constructor(config: WeightedStrategyConfig) {
        this.config = config;
        this.gammaClient = new GammaClient();
        this.priceSocket = new PriceSocket(this.onPriceUpdate.bind(this));
        this.pnlManager = new PnlManager();
    }

    async init(clobClient: ClobClient): Promise<void> {
        this.clobClient = clobClient;

        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const allowances = (res as any).allowances || {};
            const maxAllowance = Math.max(...Object.values(allowances).map(a => parseFloat(a as string)));
            const bal = parseFloat((res as any).balance || "0") / 1e6;
            this.pnlManager.updateWalletBalance(bal);

            if (maxAllowance < 1000 * 1e6) { 
                console.log(color("⚠️ Insufficient Allowance. Approving...", COLORS.YELLOW));
                await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                console.log(color("✅ Allowance Approved!", COLORS.GREEN));
            }
        } catch (e: any) {
            console.error(color(`Failed initialization check: ${e.message}`, COLORS.RED));
        }

        this.logHeader();

        setInterval(() => {
            redeemPositions().catch(e => console.error("Auto-redeem background error:", e));
        }, 60000);

        try {
            const openOrders = await this.clobClient.getOpenOrders();
            let existingRisk = 0;
            const orders = (openOrders as any).orders || openOrders;
            if (Array.isArray(orders)) {
                orders.forEach((o: any) => {
                    if (o.side === 'BUY') existingRisk += parseFloat(o.size) * parseFloat(o.price);
                });
            }
            if (existingRisk > 0) {
                console.log(color(`🔒 Seeding WalletGuard for ${this.name}: $${existingRisk.toFixed(2)}`, COLORS.MAGENTA));
                WalletGuard.registerExistingExposure(this.name, existingRisk);
            }
        } catch (e) {
            console.error("Failed to seed WalletGuard:", e);
        }
    }

    protected abstract logHeader(): void;

    async rotateToNextMarket(): Promise<void> {
        for (const c of Object.values(this.pnlManager.getAllStats().activeCycles)) {
            if (c.coin === this.config.coin && c.status === 'OPEN' && this.activeMarkets.size === 0) {
                console.log(color(`🔄 Resuming cycle ${c.id}...`, COLORS.MAGENTA));
                await this.resumeCycle(c);
                return;
            }
        }

        if (this.activeMarkets.size > 0) {
            for (const state of this.activeMarkets.values()) {
                if (state.status === 'scanning' && (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0)) {
                    await this.forceCloseMarket(state);
                    this.pnlManager.closeCycle(state.marketId, 'ABANDON', -(state.position.yes.totalCost + state.position.no.totalCost));
                }
            }
            this.priceSocket.close();
            this.activeMarkets.clear();
            if (this.statusInterval) clearInterval(this.statusInterval);
        }

        WalletGuard.clearStrategy(this.name);

        let markets: any[] = [];
        console.log(`[${this.name}] Scanning for ${this.config.coin} ${this.config.duration} markets...`);

        while (markets.length === 0) {
            markets = await this.scanUpcomingMarkets(this.config.coin, this.config.duration);
            markets = markets.filter(m => new Date(m.endDateIso || m.events?.[0]?.endDate).getTime() > Date.now());
            if (markets.length === 0) await new Promise(r => setTimeout(r, 5000));
        }

        const targetMarket = markets[0];
        await this.attachToMarket(targetMarket);
    }

    protected async attachToMarket(m: any) {
        let tokenIds: string[] = [];
        try {
            tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        } catch (e) { return this.rotateToNextMarket(); }

        const endTime = new Date(m.endDateIso || m.events?.[0]?.endDate).getTime();
        const startTime = endTime - (this.config.duration === '5m' ? 300 : 900) * 1000;

        const walletBal = this.pnlManager.getAllStats().walletBalance || 100;
        const riskPct = walletBal < 20 ? 0.50 : 0.15;
        const maxMarketUsd = walletBal * riskPct;

        box([
            `Selected: ${color(m.slug, COLORS.BRIGHT)}`,
            `Question: ${m.question}`,
            `End:      ${new Date(endTime).toLocaleTimeString()}`,
            `Max Exp:  $${maxMarketUsd.toFixed(2)}`
        ]);

        const tokenIdToSide = new Map<string, 'yes' | 'no'>();
        tokenIdToSide.set(tokenIds[0], 'yes');
        tokenIdToSide.set(tokenIds[1], 'no');

        this.activeMarkets.set(m.id, {
            marketId: m.id,
            tokenIds,
            prices: new Map(),
            tokenIdToSide,
            position: {
                yes: { totalShares: 0, totalCost: 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 },
                no: { totalShares: 0, totalCost: 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 }
            },
            status: 'scanning',
            endTime,
            startTime,
            slug: m.slug,
            question: m.question,
            bestPairCost: Infinity,
            lastImproveTs: Date.now(),
            maxMarketUsd,
            stats: { signalsDetected: 0 }
        });

        this.priceSocket.connect(tokenIds);
        this.startStatusLoop();
    }

    private onPriceUpdate(update: PriceUpdate) {
        const tokenId = update.asset_id;
        const currentPrice = parseFloat(update.price);
        const now = Date.now();

        let marketState: MarketState | undefined;
        for (const state of this.activeMarkets.values()) {
            if (state.tokenIds.includes(tokenId)) {
                marketState = state;
                break;
            }
        }
        if (!marketState || marketState.status === 'complete') return;

        // [PRE-WARM] Record price but skip execution if not yet active
        if (marketState.status === 'pre-warming') {
            if (!marketState.prices.has(tokenId)) marketState.prices.set(tokenId, []);
            const history = marketState.prices.get(tokenId)!;
            history.push({ price: currentPrice, timestamp: now });
            const cutoff = now - this.config.slidingWindowMs;
            while (history.length > 0 && history[0].timestamp < cutoff) history.shift();
            return;
        }

        const lockKey = `${marketState.marketId}-${tokenId}`;
        if (this.processingTokens.has(lockKey)) return;
        this.processingTokens.add(lockKey);

        try {
            if (!marketState.prices.has(tokenId)) marketState.prices.set(tokenId, []);
            const history = marketState.prices.get(tokenId)!;
            history.push({ price: currentPrice, timestamp: now });
            
            // Log to structured CSV
            const side = marketState.tokenIdToSide.get(tokenId) || 'unknown';
            PriceLogger.log(marketState.slug, tokenId, side.toUpperCase(), currentPrice);

            const cutoff = now - this.config.slidingWindowMs;
            while (history.length > 0 && history[0].timestamp < cutoff) history.shift();

            this.processTick(marketState, tokenId, currentPrice, history);
            this.checkPairCost(marketState);
        } finally {
            this.processingTokens.delete(lockKey);
        }
    }

    protected abstract processTick(state: MarketState, tokenId: string, currentPrice: number, history: PricePoint[]): void;

    protected async executeOrder(
        tokenId: string,
        requestedShares: number,
        price: number,
        label: string,
        bypassRisk: boolean = false,
        passiveFirst: boolean = false
    ): Promise<number> {
        if (!this.clobClient) return 0;

        const balRes = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const availableUsd = parseFloat((balRes as any).balance || "0") / 1e6;
        this.pnlManager.updateWalletBalance(availableUsd);

        const totalReserved = WalletGuard.getTotalReserved();
        const riskPct = availableUsd < 20 ? 0.60 : 0.40; 
        
        if (!bypassRisk && (totalReserved + (requestedShares * price) > (availableUsd * riskPct))) {
             return 0;
        }

        let finalShares = requestedShares;
        if (bypassRisk) finalShares = Math.floor(availableUsd / price);

        const exactCost = finalShares * price;
        if (!bypassRisk && !WalletGuard.tryReserve(this.name, exactCost, availableUsd)) {
            return 0;
        }

        try {
            console.log(color(`[${this.name}] BUY ${finalShares} @ $${price} (${label})`, COLORS.CYAN));
            const order = await this.clobClient.createAndPostOrder(
                { tokenID: tokenId, price, side: Side.BUY, size: finalShares },
                { tickSize: "0.01" }
            );

            if (order?.orderID) return finalShares;

            WalletGuard.release(this.name, exactCost);
            return 0;
        } catch (e: any) {
            WalletGuard.release(this.name, exactCost);
            return 0;
        }
    }

    protected async checkPairCost(state: MarketState) {
        if (state.status !== 'scanning' || state.arbLocked) return;
        const yes = state.position.yes;
        const no = state.position.no;
        if (yes.totalShares > 0 && no.totalShares > 0) {
            const pairCost = yes.avgPrice + no.avgPrice;
            if (pairCost <= this.config.sumTarget) {
                state.arbLocked = true;
                box([
                    color("🏆 TARGET REACHED", COLORS.BRIGHT + COLORS.YELLOW),
                    `Pair Cost: $${pairCost.toFixed(4)}`,
                    `Profit:    $${((1.0 - pairCost) * Math.min(yes.totalShares, no.totalShares)).toFixed(2)}`
                ], COLORS.YELLOW);
            }
        }
    }

    protected async checkAndExecuteEarlyExit(state: MarketState) {
        if (!this.config.earlyExit?.enabled || !this.clobClient || state.status !== 'scanning' || state.arbLocked) return;
        const yes = state.position.yes;
        const no = state.position.no;
        if (yes.totalShares <= 0 || no.totalShares <= 0) return;

        try {
            const yesBook = await this.clobClient.getOrderBook(state.tokenIds[0]);
            const noBook = await this.clobClient.getOrderBook(state.tokenIds[1]);
            if (!yesBook.bids.length || !noBook.bids.length) return;

            const matchShares = Math.min(yes.totalShares, no.totalShares);
            if (!this.hasSufficientLiquidity(yesBook.bids, matchShares) || !this.hasSufficientLiquidity(noBook.bids, matchShares)) return;

            const bestBidYes = parseFloat(yesBook.bids[0].price);
            const bestBidNo = parseFloat(noBook.bids[0].price);
            
            const exitValue = bestBidYes + bestBidNo;
            const entryCost = yes.avgPrice + no.avgPrice;
            const profitPerShare = exitValue - entryCost;
            const profitPct = profitPerShare / entryCost;
            const totalProfitUsd = profitPerShare * matchShares;

            if (profitPct < (this.config.earlyExit.minProfitPct || 0.15)) return;
            if (totalProfitUsd < (this.config.earlyExit.minProfitUsd || 0.50)) return;

            console.log(color(`\n💰 EARLY EXIT VALID: +${(profitPct * 100).toFixed(1)}% ($${totalProfitUsd.toFixed(2)})`, COLORS.BRIGHT + COLORS.GREEN));
            state.status = 'exiting';

            const yesDepth = this.getBidDepth(yesBook.bids, bestBidYes);
            const noDepth = this.getBidDepth(noBook.bids, bestBidNo);

            const [first, second] = yesDepth < noDepth ? 
                [{ id: state.tokenIds[0], qty: matchShares, px: bestBidYes, name: 'YES' }, { id: state.tokenIds[1], qty: matchShares, px: bestBidNo, name: 'NO' }] :
                [{ id: state.tokenIds[1], qty: matchShares, px: bestBidNo, name: 'NO' }, { id: state.tokenIds[0], qty: matchShares, px: bestBidYes, name: 'YES' }];

            if (await this.executeSell(first.id, first.qty, first.px, "EXIT-1") === 0) {
                state.status = 'scanning';
                return;
            }

            if (await this.executeSell(second.id, second.qty, second.px, "EXIT-2") === 0) {
                await this.emergencyHedge(second.id, second.qty, second.px * 0.7, "EXIT-FAIL-HEDGE");
                state.status = 'complete';
                this.pnlManager.closeCycle(state.marketId, "ABANDON", -matchShares * first.px);
                return;
            }

            state.position.yes.totalShares = 0;
            state.position.no.totalShares = 0;
            state.status = 'complete';
            this.pnlManager.closeCycle(state.marketId, "EARLY_EXIT", totalProfitUsd);
        } catch (e) { state.status = 'scanning'; }
    }

    protected async checkAndExecuteLateExit(state: MarketState) {
        if (!this.config.lateExit?.enabled || !this.clobClient || state.status !== 'scanning') return;
        const yes = state.position.yes;
        const no = state.position.no;
        if (yes.totalShares <= 0 || no.totalShares <= 0) return;

        const timeLeftMs = state.endTime - Date.now();
        if (timeLeftMs > (this.config.lateExit.timeRemainingSeconds || 60) * 1000) return;

        try {
            const yesBook = await this.clobClient.getOrderBook(state.tokenIds[0]);
            const noBook = await this.clobClient.getOrderBook(state.tokenIds[1]);
            if (!yesBook.bids.length || !noBook.bids.length) return;

            const bestBidYes = parseFloat(yesBook.bids[0].price);
            const bestBidNo = parseFloat(noBook.bids[0].price);
            const winnerPrice = Math.max(bestBidYes, bestBidNo);

            if (winnerPrice < (this.config.lateExit.minWinnerPrice || 0.70)) return;

            const matchShares = Math.min(yes.totalShares, no.totalShares);
            const exitValue = bestBidYes + bestBidNo;
            const entryCost = yes.avgPrice + no.avgPrice;
            const totalProfitUsd = (exitValue - entryCost) * matchShares;

            if (totalProfitUsd < (this.config.lateExit.minProfitUsd || 0.01)) return;

            console.log(color(`\n⚡ LATE DOMINANCE EXIT TRIGGERED`, COLORS.BRIGHT + COLORS.MAGENTA));
            state.status = 'exiting';

            const isYesWinner = bestBidYes > bestBidNo;
            const win = { id: state.tokenIds[isYesWinner ? 0 : 1], px: isYesWinner ? bestBidYes : bestBidNo };
            const lose = { id: state.tokenIds[isYesWinner ? 1 : 0], px: isYesWinner ? bestBidNo : bestBidYes };

            if (await this.executeSell(win.id, matchShares, win.px, "LATE-EXIT-WIN") === 0) {
                state.status = 'scanning';
                return;
            }

            if (await this.executeSell(lose.id, matchShares, lose.px, "LATE-EXIT-LOSE") === 0) {
                await this.emergencyHedge(lose.id, matchShares, lose.px * 0.7, "LATE-FAIL-HEDGE");
            }

            state.position.yes.totalShares = 0;
            state.position.no.totalShares = 0;
            state.status = 'complete';
            this.pnlManager.closeCycle(state.marketId, "LATE_EXIT", totalProfitUsd);
        } catch (e) { state.status = 'scanning'; }
    }

    protected async checkAndExecutePartialUnwind(state: MarketState) {
        if (!this.config.partialUnwind?.enabled || !this.clobClient || state.status !== 'scanning') return;
        const yes = state.position.yes;
        const no = state.position.no;
        if (yes.totalShares <= 0 || no.totalShares <= 0) return;

        const timeLeftMs = state.endTime - Date.now();
        if (timeLeftMs > (this.config.partialUnwind.timeRemainingSeconds || 45) * 1000) return;

        try {
            const yesBook = await this.clobClient.getOrderBook(state.tokenIds[0]);
            const noBook = await this.clobClient.getOrderBook(state.tokenIds[1]);
            const bestBidYes = parseFloat(yesBook.bids[0].price);
            const bestBidNo = parseFloat(noBook.bids[0].price);

            const isYesWin = bestBidYes > bestBidNo;
            const winPrice = isYesWin ? bestBidYes : bestBidNo;
            if (winPrice < (this.config.partialUnwind.minWinnerPrice || 0.70)) return;
            if ((isYesWin ? bestBidNo : bestBidYes) > 0.20) return;

            const winState = isYesWin ? yes : no;
            const totalWinProfit = (winPrice - winState.avgPrice) * winState.totalShares;
            if (totalWinProfit < (this.config.partialUnwind.minProfitUsd || 0.20)) return;

            if (!this.hasSufficientLiquidity(isYesWin ? yesBook.bids : noBook.bids, winState.totalShares)) return;

            state.status = 'partial_unwind';
            const winToken = state.tokenIds[isYesWin ? 0 : 1];

            if (await this.executeSell(winToken, winState.totalShares, winPrice, "PARTIAL-UNWIND") === 0) {
                state.status = 'scanning';
                return;
            }

            winState.totalShares = 0;
            winState.totalCost = 0;
            winState.avgPrice = 0;
            state.arbLocked = true;
            this.pnlManager.logPartialProfit(state.marketId, totalWinProfit);
            this.pnlManager.updateCycleCost(state.marketId, state.position.yes.totalCost, state.position.no.totalCost);
        } catch (e) { state.status = 'scanning'; }
    }

    protected async executeSell(tokenId: string, qty: number, px: number, label: string): Promise<number> {
        if (!this.clobClient) return 0;
        try {
            const order = await this.clobClient.createAndPostOrder(
                { tokenID: tokenId, price: px, side: Side.SELL, size: qty },
                { tickSize: "0.01" }
            );
            return order?.orderID ? qty : 0;
        } catch (e) { return 0; }
    }

    protected async emergencyHedge(tokenId: string, qty: number, px: number, label: string) {
        await this.executeSell(tokenId, qty, px, label);
    }

    protected hasSufficientLiquidity(bids: any[], needed: number): boolean {
        let cum = 0;
        for (const b of bids) {
            cum += parseFloat(b.size);
            if (cum >= needed) return true;
        }
        return false;
    }

    protected getBidDepth(bids: any[], price: number): number {
        let depth = 0;
        for (const b of bids) {
            if (parseFloat(b.price) >= price) depth += parseFloat(b.size);
        }
        return depth;
    }

    protected getLastPrice(state: MarketState, idx: number): string {
        const arr = state.prices.get(state.tokenIds[idx]);
        if (!arr || arr.length === 0) return "?.???";
        return arr[arr.length - 1].price.toFixed(3);
    }

    protected startStatusLoop() {
        if (this.statusInterval) clearInterval(this.statusInterval);
        this.statusInterval = setInterval(() => this.checkStatusAndRotate(), 5000);
    }

    protected async checkStatusAndRotate() {
        for (const state of this.activeMarkets.values()) {
            const now = Date.now();
            const timeLeft = Math.round((state.endTime - now) / 1000);
            if (state.status === 'complete') continue;
            if (state.arbLocked && timeLeft > 90) continue;

            // Naked Position Check & Force Hedge
            const isNakedYes = (state.position.yes.totalShares > 0 && state.position.no.totalShares === 0);
            const isNakedNo = (state.position.no.totalShares > 0 && state.position.yes.totalShares === 0);

            if (isNakedYes || isNakedNo) {
                const side = isNakedYes ? 'yes' : 'no';
                const age = now - state.position[side].firstBuyTs;
                if (age > this.config.leg2TimeoutSeconds * 1000) {
                    const oppSide = isNakedYes ? 'no' : 'yes';
                    const oppToken = state.tokenIds[isNakedYes ? 1 : 0];
                    const oppPx = parseFloat(this.getLastPrice(state, isNakedYes ? 1 : 0));
                    if (!isNaN(oppPx) && oppPx > 0) {
                        const filled = await this.executeOrder(oppToken, state.position[side].totalShares, oppPx, "FORCED-HEDGE", true);
                        if (filled > 0) {
                            state.position[oppSide].totalShares += filled;
                            state.position[oppSide].totalCost += filled * oppPx;
                            state.position[oppSide].avgPrice = state.position[oppSide].totalCost / state.position[oppSide].totalShares;
                            state.arbLocked = true;
                            this.pnlManager.updateCycleCost(state.marketId, state.position.yes.totalCost, state.position.no.totalCost);
                        }
                    }
                }
            }

            await this.checkAndExecutePartialUnwind(state);
            await this.checkAndExecuteLateExit(state);
            await this.checkAndExecuteEarlyExit(state);

            if (timeLeft <= 0) {
                state.status = 'complete';
                if (state.position.yes.totalShares > 0 || state.position.no.totalShares > 0) {
                    this.pnlManager.closeCycle(state.marketId, 'LOSS', -(state.position.yes.totalCost + state.position.no.totalCost));
                } else {
                    this.pnlManager.closeCycle(state.marketId, 'EXPIRED', 0);
                }
                
                const oldTokenIds = [...state.tokenIds];
                this.activeMarkets.delete(state.marketId);
                
                // If we have a pre-warmed market, promote it
                const nextMarket = Array.from(this.activeMarkets.values()).find(m => m.status === 'pre-warming');
                if (nextMarket) {
                    console.log(color(`[${this.name}] 🚀 Transitioning to pre-warmed market: ${nextMarket.slug}`, COLORS.BRIGHT + COLORS.GREEN));
                    nextMarket.status = 'scanning';
                    this.nextMarketLoaded = false;
                    this.startStatusLoop();
                } else {
                    this.rotateToNextMarket();
                }

                // Clean up old subscriptions after a short delay
                setTimeout(() => this.priceSocket.unsubscribe(oldTokenIds), 5000);
                return;
            }

            // [PRE-WARM TRIGGER]
            if (timeLeft < 35 && !this.nextMarketLoaded && state.status === 'scanning') {
                this.preWarmNextMarket().catch(e => console.error("Pre-warm error:", e));
            }

            // Compact Log
            const p1 = this.getLastPrice(state, 0);
            const p2 = this.getLastPrice(state, 1);
            const yesAvg = state.position.yes.totalShares > 0 ? state.position.yes.avgPrice.toFixed(3) : "0.000";
            const noAvg = state.position.no.totalShares > 0 ? state.position.no.avgPrice.toFixed(3) : "0.000";
            const totalSpent = state.position.yes.totalCost + state.position.no.totalCost;

            console.log(`${color("[STATUS]", COLORS.CYAN)} Time: ${timeLeft}s | Px: ${p1}/${p2} | Pos: [Y:${yesAvg} (${state.position.yes.totalShares})] [N:${noAvg} (${state.position.no.totalShares})] Exp:$${totalSpent.toFixed(2)}`);
        }
    }

    protected async forceCloseMarket(state: MarketState) {
        for (const [side, idx] of [['yes', 0], ['no', 1]] as const) {
            const qty = state.position[side as 'yes' | 'no'].totalShares;
            if (qty <= 0) continue;
            const book = await this.clobClient!.getOrderBook(state.tokenIds[idx]);
            if (book.bids.length) await this.executeSell(state.tokenIds[idx], qty, parseFloat(book.bids[0].price), `FORCE-CLOSE`);
        }
        await redeemPositions();
    }

    protected async scanUpcomingMarkets(coin: string, duration: string) {
        return await this.gammaClient.getMarkets(`slug=${coin.toLowerCase()}-updown-${duration}`);
    }

    protected async resumeCycle(c: any) {
        let markets = await this.scanUpcomingMarkets(this.config.coin, this.config.duration);
        let target = markets.find(m => m.slug === c.id || m.questionID === c.id);
        if (!target) target = (await this.gammaClient.getMarkets(`slug=${c.id}`))[0];
        if (target && new Date(target.endDateIso || target.events?.[0]?.endDate).getTime() > Date.now()) {
            await this.attachToMarket(target);
            const mState = this.activeMarkets.get(target.id)!;
            mState.position.yes.totalCost = c.yesCost || 0;
            mState.position.no.totalCost = c.noCost || 0;
        } else {
            this.pnlManager.closeCycle(c.id, 'ABANDON', 0);
            this.rotateToNextMarket();
        }
    }

    protected async preWarmNextMarket() {
        if (this.nextMarketLoaded) return;
        this.nextMarketLoaded = true;

        console.log(color(`[${this.name}] 🕒 Pre-warming next market cycle...`, COLORS.DIM + COLORS.CYAN));
        
        let markets = await this.scanUpcomingMarkets(this.config.coin, this.config.duration);
        // Find the market that starts AFTER the current one(s)
        const currentEndTimes = Array.from(this.activeMarkets.values())
            .filter(m => m.status !== 'pre-warming')
            .map(m => m.endTime);
        const maxCurrentEnd = currentEndTimes.length > 0 ? Math.max(...currentEndTimes) : Date.now();

        const next = markets.find(m => {
            const end = new Date(m.endDateIso || m.events?.[0]?.endDate).getTime();
            const start = end - (this.config.duration === '5m' ? 300 : 900) * 1000;
            return start >= maxCurrentEnd - 10000 && end > Date.now();
        });

        if (next && !this.activeMarkets.has(next.id)) {
            console.log(color(`[${this.name}] 📥 Found next market: ${next.slug}. Subscribing to tokens...`, COLORS.CYAN));
            
            let tokenIds: string[] = [];
            try {
                tokenIds = typeof next.clobTokenIds === 'string' ? JSON.parse(next.clobTokenIds) : next.clobTokenIds;
            } catch (e) { this.nextMarketLoaded = false; return; }

            const endTime = new Date(next.endDateIso || next.events?.[0]?.endDate).getTime();
            const startTime = endTime - (this.config.duration === '5m' ? 300 : 900) * 1000;

            const tokenIdToSide = new Map<string, 'yes' | 'no'>();
            tokenIdToSide.set(tokenIds[0], 'yes');
            tokenIdToSide.set(tokenIds[1], 'no');

            this.activeMarkets.set(next.id, {
                marketId: next.id,
                tokenIds,
                prices: new Map(),
                tokenIdToSide,
                position: {
                    yes: { totalShares: 0, totalCost: 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 },
                    no: { totalShares: 0, totalCost: 0, avgPrice: 0, buysTriggered: 0, isBuying: false, lastBuyTs: 0, firstBuyTs: 0 }
                },
                status: 'pre-warming',
                endTime,
                startTime,
                slug: next.slug,
                question: next.question,
                bestPairCost: Infinity,
                lastImproveTs: Date.now(),
                maxMarketUsd: 0, // Not calculated yet
                stats: { signalsDetected: 0 }
            });

            this.priceSocket.subscribe(tokenIds);
        } else {
            this.nextMarketLoaded = false;
        }
    }

    async run(): Promise<void> {
        if (this.config.redeem) { await redeemPositions(); process.exit(0); }
        await this.rotateToNextMarket();
    }

    async cleanup(): Promise<void> {
        this.priceSocket.close();
        if (this.statusInterval) clearInterval(this.statusInterval);
    }
}
