import fs from "fs";
import path from "path";

/**
 * SessionLogger
 * Captures detailed performance benchmarks sequentially mapped by launch.
 */
export class SessionLogger {
    private static sessionDir: string = "";
    private static initialized = false;

    public static init(strategyName: string, config: any): void {
        if (this.initialized) return;

        const timestamp = Date.now();
        const safeName = strategyName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        this.sessionDir = path.join(process.cwd(), "data", "sessions", `session_${timestamp}_${safeName}`);

        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        const metaPath = path.join(this.sessionDir, "strategy_config.json");
        fs.writeFileSync(metaPath, JSON.stringify({
            strategy: strategyName,
            timestamp,
            isoTime: new Date(timestamp).toISOString(),
            cliArgs: config
        }, null, 2));

        this.initialized = true;
        console.log(`[SessionLogger] 📁 Performance telemetry initialized: ${path.basename(this.sessionDir)}`);
    }

    public static logPerformance(data: any): void {
        if (!this.initialized) return;
        
        const filePath = path.join(this.sessionDir, "performance.jsonl");
        const record = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            ...data
        };

        fs.appendFile(filePath, JSON.stringify(record) + "\n", (err) => {
            if (err) console.error(`[SessionLogger] Error:`, err);
        });
    }

    public static getSessionDir(): string {
        return this.sessionDir;
    }
}
