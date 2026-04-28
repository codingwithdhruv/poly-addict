import WebSocket from "ws";
import https from "https";

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    isClosed: boolean;
}

export interface BybitTrackerConfig {
    interval?: string;       // "5", "15"
    symbol?: string;         // "BTCUSDT"
    windowSize?: number;     // Number of trailing blocks to form range channel
    maxRangePct?: number;    // Tight range threshold (0.0030 = 0.30%)
}

const COLORS = {
    RESET: "\x1b[0m",
    DIM: "\x1b[2m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
};

export class BybitConditionTracker {
    private ws?: WebSocket;
    private symbol: string;
    private interval: string;
    private windowSize: number;
    private maxRangePct: number;

    private history: Candle[] = [];
    private liveCandle?: Candle;
    
    private pingInterval?: NodeJS.Timeout;
    private isConnected = false;
    private channelName: string;

    constructor(config: BybitTrackerConfig = {}) {
        this.symbol = config.symbol || "BTCUSDT";
        this.interval = config.interval || "5";
        this.windowSize = config.windowSize || 3;
        this.maxRangePct = config.maxRangePct || 0.0030; // default 0.30%
        this.channelName = `kline.${this.interval}.${this.symbol}`;
    }

    public async init() {
        await this.syncHistoryViaRest();
        this.connectWs();
    }

    private async syncHistoryViaRest() {
        return new Promise<void>((resolve) => {
            const limit = this.windowSize + 1;
            const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${this.symbol}&interval=${this.interval}&limit=${limit}`;
            
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed?.result?.list && Array.isArray(parsed.result.list)) {
                            const list = parsed.result.list;
                            // List is newest first (0 is live)
                            this.history = [];
                            // Start from oldest to newest (skip index 0 which is live)
                            for (let i = list.length - 1; i > 0; i--) {
                                const k = list[i];
                                this.history.push({
                                    timestamp: parseInt(k[0]),
                                    open: parseFloat(k[1]),
                                    high: parseFloat(k[2]),
                                    low: parseFloat(k[3]),
                                    close: parseFloat(k[4]),
                                    isClosed: true
                                });
                            }
                            console.log(`[Bybit Tracker] Seeded ${this.history.length} historical candles from REST API.`);
                        }
                    } catch (e) {
                        console.error("[Bybit Tracker] Failed to parse REST history:", e);
                    }
                    resolve();
                });
            }).on('error', (err) => {
                console.error("[Bybit Tracker] REST history fetch error:", err.message);
                resolve();
            });
        });
    }

    private connectWs() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }

        const WSS_URL = "wss://stream.bybit.com/v5/public/spot";
        this.ws = new WebSocket(WSS_URL);

        this.ws.on("open", () => {
            this.isConnected = true;
            console.log(`[Bybit Tracker] Connected to WS. Subscribing to ${this.channelName}...`);
            
            const subMsg = {
                req_id: `sub_${Date.now()}`,
                op: "subscribe",
                args: [this.channelName]
            };
            this.ws?.send(JSON.stringify(subMsg));

            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ req_id: "ping_" + Date.now(), op: "ping" }));
                }
            }, 20000);
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
            try {
                const parsed = JSON.parse(data.toString());
                
                // Handle ping pong
                if (parsed.op === "ping" || parsed.ret_msg === "pong") return;
                
                if (parsed.topic === this.channelName && parsed.data) {
                    const latest = parsed.data[0];
                    if (!latest) return;
                    
                    const isConfirm = latest.confirm === true;
                    const candle: Candle = {
                        timestamp: parseInt(latest.start),
                        open: parseFloat(latest.open),
                        high: parseFloat(latest.high),
                        low: parseFloat(latest.low),
                        close: parseFloat(latest.close),
                        isClosed: isConfirm
                    };

                    this.liveCandle = candle;

                    if (isConfirm) {
                        // Check if we already have this candle (dedupe via timestamp)
                        const exists = this.history.find(c => c.timestamp === candle.timestamp);
                        if (!exists) {
                            this.history.push(candle);
                            if (this.history.length > this.windowSize) {
                                this.history.shift(); // Keep bounded
                            }
                        }
                    }
                }
            } catch (e) {
                // suppress generic parse errors
            }
        });

        this.ws.on("close", () => {
            this.isConnected = false;
            if (this.pingInterval) clearInterval(this.pingInterval);
            setTimeout(() => this.connectWs(), 3000);
        });

        this.ws.on("error", (err) => {
            console.error(`[Bybit Tracker] WS Error: ${err.message}`);
        });
    }

    /**
     * Determines if the market is cleanly moving sideways in a tight range.
     * Returns false if there's a breakout above the channel or the channel itself is too wide.
     */
    public isConsolidating(): boolean {
        // Soft fallback: if we don't have enough history, allow trading
        if (this.history.length < this.windowSize) {
            return true; 
        }

        // Establish the Baseline Channel from trailing closed candles
        let channelHigh = -Infinity;
        let channelLow = Infinity;

        for (const c of this.history) {
            if (c.high > channelHigh) channelHigh = c.high;
            if (c.low < channelLow) channelLow = c.low;
        }

        const channelRangeAbs = channelHigh - channelLow;
        const channelRangePct = channelRangeAbs / channelLow;

        // Is the channel inherently too wide? (Volatile expansion phase)
        if (channelRangePct > this.maxRangePct) {
            this.logConsolidationState(false, `Baseline channel too wide ($${channelRangeAbs.toFixed(0)} > ${Math.round(this.maxRangePct*10000)/100}%)`);
            return false;
        }

        // Check if the current live price has broken out of the established channel
        if (this.liveCandle) {
            // We use CLOSE for breakout confirmation. If the live close goes beyond the channel, it's directing.
            // Using close allows wicks outside the channel to still be considered sideways if they snap back.
            if (this.liveCandle.close > channelHigh) {
                this.logConsolidationState(false, `BREAKOUT UP! Live Close $${this.liveCandle.close.toFixed(0)} > Range Top $${channelHigh.toFixed(0)}`);
                return false;
            }
            if (this.liveCandle.close < channelLow) {
                this.logConsolidationState(false, `BREAKOUT DOWN! Live Close $${this.liveCandle.close.toFixed(0)} < Range Bottom $${channelLow.toFixed(0)}`);
                return false;
            }
        }

        this.logConsolidationState(true, `Range tight: $${channelLow.toFixed(0)} - $${channelHigh.toFixed(0)} (${(channelRangePct * 100).toFixed(2)}%)`);
        return true;
    }

    // Rate limited logger to prevent spamming the console
    private lastLogTs = 0;
    private logConsolidationState(isConsolidating: boolean, reason: string) {
        const now = Date.now();
        if (now - this.lastLogTs > 30000) { // Log once every 30s max
            this.lastLogTs = now;
            if (isConsolidating) {
                console.log(`${COLORS.CYAN}[Bybit Tracker] ${COLORS.GREEN}Sideways Market Detected. ${COLORS.DIM}${reason}${COLORS.RESET}`);
            } else {
                console.log(`${COLORS.YELLOW}[Bybit Tracker] ${COLORS.RED}Directional Market Detected. Pausing new entries. ${COLORS.RESET}Reason: ${reason}`);
            }
        }
    }

    public close() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }
        if (this.pingInterval) clearInterval(this.pingInterval);
    }
}
