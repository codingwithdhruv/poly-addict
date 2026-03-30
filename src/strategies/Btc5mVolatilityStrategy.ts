import { BaseWeightedStrategy, MarketState, PricePoint, color, COLORS, box } from "./BaseWeightedStrategy.js";

/**
 * Btc5mVolatilityStrategy
 * Optimized for high-frequency BTC 5m markets with aggressive entry and early exit.
 */
export class Btc5mVolatilityStrategy extends BaseWeightedStrategy {
    name = "BTC 5m Volatility Strategy";

    constructor(config: any = {}) {
        super({
            coin: config.coin || "BTC",
            duration: '5m',
            dipThreshold: config.dipThreshold || 0.10,
            slidingWindowMs: config.slidingWindowMs || 2500,
            sumTarget: config.sumTarget || 0.94,
            shares: config.shares || 20,
            leg2TimeoutSeconds: config.leg2TimeoutSeconds || 45,
            ignorePriceBelow: config.ignorePriceBelow || 0,
            verbose: config.verbose || false,
            info: config.info || false,
            redeem: config.redeem || false,
            dashboard: config.dashboard || false,
            earlyExit: config.earlyExit || { enabled: true, minProfitPct: 0.08, minProfitUsd: 0.30, maxSlippagePct: 0.03 },
            lateExit: config.lateExit || { enabled: true, timeRemainingSeconds: 45, minWinnerPrice: 0.70, minProfitUsd: 0.01 },
            partialUnwind: config.partialUnwind || { enabled: true, timeRemainingSeconds: 30, minWinnerPrice: 0.70, minProfitUsd: 0.15 }
        });
    }

    protected logHeader() {
        box([
            `    ${color("BTC 5M VOLATILITY REAPER", COLORS.BRIGHT + COLORS.RED)}    `,
            "",
            `Coin:        ${this.config.coin}`,
            `Dip:         ${(this.config.dipThreshold * 100).toFixed(0)}%`,
            `Target:      ${this.config.sumTarget}`,
        ], COLORS.RED);
    }

    protected async processTick(state: MarketState, tokenId: string, currentPrice: number, history: PricePoint[]) {
        if (state.status !== 'scanning' || state.arbLocked) return;

        // Background Lazy Load (30s before expiry)
        const timeLeft = Math.round((state.endTime - Date.now()) / 1000);
        if (timeLeft <= 30 && timeLeft > 0 && !this.nextMarketLoaded) {
            this.lazyLoadNextMarket();
        }

        let highPrice = 0;
        for (const p of history) if (p.price > highPrice) highPrice = p.price;

        if (highPrice > 0 && history.length > 2) {
            const drop = (highPrice - currentPrice) / highPrice;
            if (drop >= this.config.dipThreshold) {
                
                const side = state.tokenIdToSide.get(tokenId)!;
                const sideState = state.position[side];

                if (sideState.isBuying || (Date.now() - sideState.lastBuyTs < 1500)) return;

                if (sideState.totalShares === 0 && state.position.yes.totalShares === 0 && state.position.no.totalShares === 0) {
                    this.pnlManager.startCycle(this.config.coin, state.marketId, state.slug);
                }

                sideState.isBuying = true;
                try {
                    const filled = await this.executeOrder(tokenId, this.config.shares, currentPrice, `VOL-DIP ${side.toUpperCase()}`);
                    if (filled > 0) {
                        if (sideState.totalShares === 0) sideState.firstBuyTs = Date.now();
                        sideState.totalShares += filled;
                        sideState.totalCost += (filled * currentPrice);
                        sideState.avgPrice = sideState.totalCost / sideState.totalShares;
                        sideState.lastBuyTs = Date.now();
                        this.pnlManager.updateCycleCost(state.marketId, state.position.yes.totalCost, state.position.no.totalCost);
                    }
                } finally {
                    sideState.isBuying = false;
                }
            }
        }
    }

    private async lazyLoadNextMarket() {
        if (this.nextMarketLoaded) return;
        this.nextMarketLoaded = true;
        console.log(color("⏳ Swarm Warming next 5m market...", COLORS.MAGENTA));
        try {
            const markets = await this.scanUpcomingMarkets(this.config.coin, '5m');
            const next = markets.find(m => new Date(m.endDateIso || m.events?.[0]?.endDate).getTime() > Date.now() + 60000);
            if (next) {
                const tokenIds = typeof next.clobTokenIds === 'string' ? JSON.parse(next.clobTokenIds) : next.clobTokenIds;
                if (tokenIds.length === 2) (this.priceSocket as any).subscribe?.(tokenIds);
            }
        } catch(e) {}
    }
}
