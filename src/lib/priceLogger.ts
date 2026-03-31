import fs from "fs";
import path from "path";

/**
 * PriceLogger
 * Handles structured CSV logging of price movements for all active strategies.
 */
export class PriceLogger {
    private static logDir = path.join(process.cwd(), "data", "price_logs");
    private static dirCreated = false;
    
    private static marketStates = new Map<string, { yesPrice: number, noPrice: number, lastLogTs: number }>();

    /**
     * Appends a synchronized price snapshot to a market-specific CSV file every 5 seconds.
     * @param marketSlug The identifying slug for the market
     * @param tokenId The unique token ID being updated
     * @param side 'YES' or 'NO'
     * @param price Current price from WebSocket or CLOB
     */
    public static log(marketSlug: string, tokenId: string, side: string, price: number): void {
        this.ensureDir();

        let state = this.marketStates.get(marketSlug);
        if (!state) {
            state = { yesPrice: 0, noPrice: 0, lastLogTs: 0 };
            this.marketStates.set(marketSlug, state);
        }

        if (side === 'YES') state.yesPrice = price;
        else if (side === 'NO') state.noPrice = price;

        // Only log if we have initialized both sides of the book
        if (state.yesPrice > 0 && state.noPrice > 0) {
            const now = Date.now();
            if (now - state.lastLogTs >= 5000) {
                state.lastLogTs = now;

                const filePath = path.join(this.logDir, `${marketSlug}.csv`);
                const isoTime = new Date(now).toISOString();
                
                const exists = fs.existsSync(filePath);
                if (!exists) {
                    fs.writeFileSync(filePath, "timestamp,isoTime,yesPrice,noPrice,sumPrice\n");
                }

                const sumPrice = parseFloat((state.yesPrice + state.noPrice).toFixed(2));
                const line = `${now},${isoTime},${state.yesPrice},${state.noPrice},${sumPrice}\n`;
                
                // Asynchronous append to avoid blocking strategy execution
                fs.appendFile(filePath, line, (err) => {
                    if (err) console.error(`[PriceLogger] Error writing to ${filePath}:`, err);
                });
            }
        }
    }

    private static ensureDir() {
        if (this.dirCreated) return;
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        this.dirCreated = true;
    }
}
