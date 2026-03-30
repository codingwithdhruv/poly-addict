import fs from "fs";
import path from "path";

/**
 * PriceLogger
 * Handles structured CSV logging of price movements for all active strategies.
 */
export class PriceLogger {
    private static logDir = path.join(process.cwd(), "data", "price_logs");
    private static dirCreated = false;

    /**
     * Appends a price update to a market-specific CSV file.
     * @param marketSlug The identifying slug for the market (e.g. btc-updown-5m-1774861500)
     * @param tokenId The unique token ID being updated
     * @param side 'YES' or 'NO'
     * @param price Current price from WebSocket or CLOB
     */
    public static log(marketSlug: string, tokenId: string, side: string, price: number): void {
        this.ensureDir();

        const filePath = path.join(this.logDir, `${marketSlug}.csv`);
        const now = Date.now();
        const isoTime = new Date(now).toISOString();

        // Header: timestamp,isoTime,tokenId,side,price
        const exists = fs.existsSync(filePath);
        if (!exists) {
            fs.writeFileSync(filePath, "timestamp,isoTime,tokenId,side,price\n");
        }

        const line = `${now},${isoTime},${tokenId},${side},${price}\n`;
        
        // Asynchronous append to avoid blocking strategy execution
        fs.appendFile(filePath, line, (err) => {
            if (err) console.error(`[PriceLogger] Error writing to ${filePath}:`, err);
        });
    }

    private static ensureDir() {
        if (this.dirCreated) return;
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        this.dirCreated = true;
    }
}
