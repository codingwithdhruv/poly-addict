import { BaseWeightedStrategy, MarketState, PricePoint, color, COLORS, box, WeightedStrategyConfig } from "./BaseWeightedStrategy.js";

export type DipArbConfig = WeightedStrategyConfig;

/**
 * Generic15mDipArbStrategy
 * Focused on 15m Up/Down markets with Dip-finding entry logic.
 */
export class Generic15mDipArbStrategy extends BaseWeightedStrategy {
    name = "Generic 15m Dip/Arb Strategy";

    constructor(config: any = {}) {
        super({
            coin: config.coin || "ETH",
            duration: '15m',
            dipThreshold: config.dipThreshold || 0.15,
            slidingWindowMs: config.slidingWindowMs || 3000,
            sumTarget: config.sumTarget || 0.95,
            shares: config.shares || 10,
            leg2TimeoutSeconds: config.leg2TimeoutSeconds || 60,
            ignorePriceBelow: config.ignorePriceBelow || 0,
            verbose: config.verbose || false,
            info: config.info || false,
            redeem: config.redeem || false,
            dashboard: config.dashboard || false,
            earlyExit: config.earlyExit || { enabled: true, minProfitPct: 0.10, minProfitUsd: 0.50, maxSlippagePct: 0.03 },
            lateExit: config.lateExit || { enabled: true, timeRemainingSeconds: 60, minWinnerPrice: 0.70, minProfitUsd: 0.01 },
            partialUnwind: config.partialUnwind || { enabled: true, timeRemainingSeconds: 45, minWinnerPrice: 0.70, minProfitUsd: 0.20 }
        });
    }

    protected logHeader() {
        box([
            `    ${color("THE SMART APE - GABAGOOL 15M", COLORS.BRIGHT + COLORS.CYAN)}    `,
            "",
            `Coin:        ${this.config.coin}`,
            `Dip:         ${(this.config.dipThreshold * 100).toFixed(0)}%`,
            `Target:      ${this.config.sumTarget}`,
        ], COLORS.CYAN);
    }

    protected async processTick(state: MarketState, tokenId: string, currentPrice: number, history: PricePoint[]) {
        if (state.status !== 'scanning' || state.arbLocked) return;

        let highPrice = 0;
        for (const p of history) if (p.price > highPrice) highPrice = p.price;

        if (highPrice > 0 && history.length > 2) {
            if (this.config.ignorePriceBelow && currentPrice < this.config.ignorePriceBelow) return;

            const drop = (highPrice - currentPrice) / highPrice;
            if (drop >= this.config.dipThreshold) {
                
                // Stabilization Check
                const last5 = history.slice(-5);
                const minInWindow = Math.min(...last5.map(p => p.price));
                if (currentPrice <= minInWindow && history.length > 5) return;

                const side = state.tokenIdToSide.get(tokenId)!;
                const sideState = state.position[side];

                if (sideState.isBuying || (Date.now() - sideState.lastBuyTs < 2500)) return;

                // Liability Checks
                const yesShares = state.position.yes.totalShares;
                const noShares = state.position.no.totalShares;
                if (side === 'yes' && yesShares > noShares + (2 * this.config.shares)) return;
                if (side === 'no' && noShares > yesShares + (2 * this.config.shares)) return;

                // Trigger PnL Cycle Start
                if (yesShares === 0 && noShares === 0) {
                    this.pnlManager.startCycle(this.config.coin, state.marketId, state.slug);
                }

                sideState.isBuying = true;
                try {
                    const filled = await this.executeOrder(tokenId, this.config.shares, currentPrice, `DIP ${side.toUpperCase()}`);
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
}
