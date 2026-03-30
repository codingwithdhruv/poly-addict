/**
 * WalletGuard
 * Singleton class to track "In-Flight" reserved funds across strategy instances.
 * Prevents multiple strategies (if running in same process) from over-committing the wallet.
 * 
 * AUDIT FIX: Now tracks exposure per-strategy to prevent one strategy's rotation
 * from wiping another strategy's active reservations.
 */
export class WalletGuard {
    private static strategyExposures: Map<string, number> = new Map();
    private static totalInFlight = 0;

    /**
     * Attempts to reserve an amount of USD for a specific strategy.
     * @param strategyName - Name of the calling strategy
     * @param amount - Amount to reserve
     * @param balance - Current wallet balance from RPC
     * @returns true if reservation successful (balance - totalReserved >= amount), else false
     */
    static tryReserve(strategyName: string, amount: number, balance: number): boolean {
        if (this.totalInFlight + amount > balance) {
            return false;
        }

        // Add to total
        this.totalInFlight += amount;

        // Track per-strategy
        const current = this.strategyExposures.get(strategyName) || 0;
        this.strategyExposures.set(strategyName, current + amount);
        
        return true;
    }

    /**
     * Releases a previously reserved amount for a specific strategy.
     * @param strategyName - Name of the calling strategy
     * @param amount - Amount to release
     */
    static release(strategyName: string, amount: number) {
        this.totalInFlight -= amount;
        if (this.totalInFlight < 0) this.totalInFlight = 0; // Safety clamp

        const current = this.strategyExposures.get(strategyName) || 0;
        const newVal = current - amount;
        this.strategyExposures.set(strategyName, newVal < 0 ? 0 : newVal);
    }

    /**
     * Returns total reserved funds across all strategies.
     */
    static getTotalReserved(): number {
        return this.totalInFlight;
    }

    /**
     * Returns reserved funds for a specific strategy.
     */
    static getStrategyReserved(strategyName: string): number {
        return this.strategyExposures.get(strategyName) || 0;
    }

    /**
     * Clears exposure for a specific strategy only.
     * Used during market rotation to ensure the strategy starts fresh,
     * without affecting other running strategies.
     */
    static clearStrategy(strategyName: string) {
        const current = this.strategyExposures.get(strategyName) || 0;
        this.totalInFlight -= current;
        if (this.totalInFlight < 0) this.totalInFlight = 0;
        this.strategyExposures.set(strategyName, 0);
    }

    /**
     * Registers existing exposure (e.g. on restart) for a strategy.
     */
    static registerExistingExposure(strategyName: string, amount: number) {
        this.totalInFlight += amount;
        const current = this.strategyExposures.get(strategyName) || 0;
        this.strategyExposures.set(strategyName, current + amount);
    }

    /**
     * DANGEROUS: Wipes EVERYTHING. Only for debugging or full-system reset.
     */
    static resetAll() {
        this.strategyExposures.clear();
        this.totalInFlight = 0;
    }
}
