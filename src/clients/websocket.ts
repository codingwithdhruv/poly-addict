import { WebSocket } from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface PriceUpdate {
    asset_id: string;
    price: string;
    timestamp: string;
    event_type: string;
}

interface SocketMeta {
    ws: WebSocket;
    id: number;
    latencyEma: number;
    lastMessageTs: number;
    isActive: boolean;
    isGracePeriod: boolean; // NEW: Block reaper while connecting
}

/**
 * PriceSocket - God-Tier WebSocket Swarm
 * Manages 50+ staggered connections to minimize latency (P99 < 10ms).
 * Implements Anti-Jitter Reaper and Stale Tick Guards.
 */
export class PriceSocket {
    private onPriceCallback: (update: PriceUpdate) => void;
    private subscriptions: string[] = [];
    private swarm: Map<number, SocketMeta> = new Map();
    private swarmSize: number;
    private isClosed = false;
    private nextWorkerId = 0;

    // God-Tier tracking
    private lastSeenPrice: Map<string, number> = new Map();
    private lastEventHash: string[] = []; // Sliding window array
    private MAX_HASH_WINDOW = 200;

    private firstBodyBypassed: Map<number, boolean> = new Map();

    // Reaper
    private reaperInterval?: NodeJS.Timeout;
    private respawnCounter = 0;
    private lastRespawnReset = Date.now();

    constructor(onPrice: (update: PriceUpdate) => void, swarmSize: number = 3) {
        this.onPriceCallback = onPrice;
        this.swarmSize = swarmSize;
    }

    connect(assetIds: string[]) {
        if (assetIds.length === 0) return;
        this.isClosed = false;
        this.subscriptions = [...assetIds];
        this.lastSeenPrice.clear();
        this.lastEventHash = [];

        console.log(`[WS-SWARM] Spinning up ${this.swarmSize} WebSockets for ${assetIds.length} tokens...`);

        // Stagger startup (100ms intervals to avoid Cloudflare rate limits)
        for (let i = 0; i < this.swarmSize; i++) {
            setTimeout(() => {
                if (!this.isClosed) this.spawnWorker(false);
            }, i * 100);
        }

        // Anti-Jitter Reaper (4s check)
        if (this.reaperInterval) clearInterval(this.reaperInterval);
        this.reaperInterval = setInterval(() => this.reaperTick(), 4000);
    }

    public isConnected(): boolean {
        return this.swarm.size > 0 && !this.isClosed;
    }

    subscribe(assetIds: string[]) {
        const newIds = assetIds.filter(id => !this.subscriptions.includes(id));
        if (newIds.length === 0) return;
        this.subscriptions.push(...newIds);
        const msg = { type: "market", assets_ids: this.subscriptions };
        for (const meta of this.swarm.values()) {
            if (meta.isActive) {
                try { meta.ws.send(JSON.stringify(msg)); } catch (e) { }
            }
        }
    }

    unsubscribe(assetIds: string[]) {
        this.subscriptions = this.subscriptions.filter(id => !assetIds.includes(id));
        const msg = { type: "market", assets_ids: this.subscriptions };
        for (const meta of this.swarm.values()) {
            if (meta.isActive) {
                try { meta.ws.send(JSON.stringify(msg)); } catch (e) { }
            }
        }
    }

    private spawnWorker(isRespawn: boolean) {
        if (this.isClosed) return;
        const id = this.nextWorkerId++;
        const ws = new WebSocket(WS_URL);

        const meta: SocketMeta = {
            ws,
            id,
            latencyEma: 1000, 
            lastMessageTs: Date.now(),
            isActive: false,
            isGracePeriod: true
        };
        this.swarm.set(id, meta);
        this.firstBodyBypassed.set(id, false);

        ws.on("open", () => {
            meta.isActive = true;
            // End grace period after 5s
            setTimeout(() => { meta.isGracePeriod = false; }, 5000);

            const msg = { type: "market", assets_ids: this.subscriptions };
            try { ws.send(JSON.stringify(msg)); } catch (e) { }
        });

        ws.on("message", (data: WebSocket.RawData) => {
            const now = Date.now();
            const delay = now - meta.lastMessageTs;
            meta.latencyEma = (meta.latencyEma * 0.8) + (delay * 0.2); 
            meta.lastMessageTs = now;

            try {
                const strData = data.toString();
                if (!strData.trim().startsWith("{")) return;
                const parsed = JSON.parse(strData);

                if (parsed.event_type === "last_trade_price") {
                    this.processTick(id, parsed, now);
                }
            } catch (e) { }
        });

        ws.on("close", () => {
            const currentMeta = this.swarm.get(id);
            // ONLY self-heal if not already removed by reaper or intentional closure
            if (currentMeta && !this.isClosed) {
                this.swarm.delete(id);
                setTimeout(() => this.spawnWorker(true), 1000);
            }
        });
        
        ws.on("error", (err) => {
            if (!this.isClosed) {
                console.warn(`[WS-SWARM] Worker ${id} error: ${err.message}`);
                // Worker will be cleaned up by 'close' event which usually follows error
            }
        });
    }

    private processTick(workerId: number, update: PriceUpdate, now: number) {
        // [Layer 3] - First Tick Skip (Stale snapshot drop)
        if (!this.firstBodyBypassed.get(workerId)) {
            this.firstBodyBypassed.set(workerId, true);
            return;
        }

        const price = parseFloat(update.price);
        const lastP = this.lastSeenPrice.get(update.asset_id);

        // [Layer 2] - Stale Tick Guard (0.15 jump rejection)
        if (lastP !== undefined) {
            const delta = Math.abs(lastP - price);
            if (delta > 0.15) return;
        }

        // [Additional 1] - Dedupe with Sliding Window
        const hash = `${update.asset_id}-${update.price}-${update.timestamp}`;
        if (this.lastEventHash.includes(hash)) return;

        this.lastEventHash.push(hash);
        if (this.lastEventHash.length > this.MAX_HASH_WINDOW) {
            this.lastEventHash.shift();
        }

        this.lastSeenPrice.set(update.asset_id, price);
        this.onPriceCallback(update);
    }

    private reaperTick() {
        if (this.isClosed) return;

        const now = Date.now();
        // Action budget: Max 20 respawns per minute
        if (now - this.lastRespawnReset > 60000) {
            this.respawnCounter = 0;
            this.lastRespawnReset = now;
        }

        const activeWorkers = Array.from(this.swarm.values()).filter(w => w.isActive && !w.isGracePeriod);
        if (activeWorkers.length < (this.swarmSize * 0.8)) return; // Don't cull if below 80% strength

        // Sort by Latency descending
        activeWorkers.sort((a, b) => b.latencyEma - a.latencyEma);

        // Cull slowest 10% (max 2 per tick)
        const cullCount = Math.min(Math.ceil(activeWorkers.length * 0.10), 2);
        
        let culled = 0;
        for (let i = 0; i < cullCount; i++) {
            if (this.respawnCounter >= 20) break;

            const target = activeWorkers[i];
            
            // Terminate and prevent auto-reconnect trigger
            this.swarm.delete(target.id); 
            try { target.ws.close(); } catch (e) {}

            this.respawnCounter++;
            culled++;
            
            // Stagger spawn the replacement
            setTimeout(() => this.spawnWorker(true), culled * 50);
        }
    }

    close() {
        this.isClosed = true;
        if (this.reaperInterval) clearInterval(this.reaperInterval);
        for (const meta of this.swarm.values()) {
            this.swarm.delete(meta.id); // Block onClose auto-heal
            try { meta.ws.close(); } catch (e) {}
        }
        this.swarm.clear();
    }
}
