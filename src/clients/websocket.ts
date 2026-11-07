import type { ClobClient } from "./clob.js";

export interface PriceUpdate {
    asset_id: string;
    price: string;
    timestamp: string;
    event_type: string;
}

interface MarketSubscriber {
    subscribeMarket(assetIds: string[]): Promise<any>;
}

/** Market feed backed by the official SDK's managed WebSocket subscription. */
export class PriceSocket {
    private subscriber?: MarketSubscriber;
    private subscriptions = new Set<string>();
    private isClosed = false;
    private isActive = false;
    private generation = 0;
    private retryAttempt = 0;
    private reconnectTimer?: NodeJS.Timeout;
    private handle?: { close(): Promise<void> };
    private readonly seenHashes = new Set<string>();
    private readonly seenHashOrder: string[] = [];
    private readonly maxSeenHashes = 1000;

    constructor(
        private readonly onPriceCallback: (update: PriceUpdate) => void,
        _legacySwarmSize?: number,
    ) {}

    setClient(client: ClobClient): void {
        this.subscriber = client;
        if (this.subscriptions.size > 0 && !this.isClosed) this.restart();
    }

    connect(assetIds: string[]): void {
        if (assetIds.length === 0) return;
        this.isClosed = false;
        this.subscriptions = new Set(assetIds.filter(isValidAssetId));
        this.seenHashes.clear();
        this.seenHashOrder.length = 0;
        this.restart();
    }

    isConnected(): boolean {
        return this.isActive && !this.isClosed;
    }

    subscribe(assetIds: string[]): void {
        let changed = false;
        for (const assetId of assetIds) {
            if (isValidAssetId(assetId) && !this.subscriptions.has(assetId)) {
                this.subscriptions.add(assetId);
                changed = true;
            }
        }
        if (changed && !this.isClosed) this.restart();
    }

    unsubscribe(assetIds: string[]): void {
        let changed = false;
        for (const assetId of assetIds) changed = this.subscriptions.delete(assetId) || changed;
        if (changed && !this.isClosed) this.restart();
    }

    private restart(): void {
        const generation = ++this.generation;
        this.isActive = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;

        const oldHandle = this.handle;
        this.handle = undefined;
        if (oldHandle) void oldHandle.close().catch((error) => {
            console.warn("[Market stream] Failed to close the previous subscription:", error);
        });

        if (this.isClosed || !this.subscriber || this.subscriptions.size === 0) return;
        void this.runSubscription(generation);
    }

    private async runSubscription(generation: number): Promise<void> {
        const assetIds = [...this.subscriptions];
        let handle: Awaited<ReturnType<MarketSubscriber["subscribeMarket"]>> | undefined;
        try {
            handle = await this.subscriber!.subscribeMarket(assetIds);
            if (generation !== this.generation || this.isClosed) {
                await handle.close();
                return;
            }

            this.handle = handle;
            this.isActive = true;
            this.retryAttempt = 0;

            for await (const event of handle as AsyncIterable<any>) {
                if (generation !== this.generation || this.isClosed) break;
                this.handleEvent(event);
            }
        } catch (error) {
            if (generation === this.generation && !this.isClosed) {
                console.warn("[Market stream] Subscription ended; reconnecting:", error);
            }
        } finally {
            if (generation === this.generation) {
                this.isActive = false;
                if (this.handle === handle) this.handle = undefined;
                if (!this.isClosed && this.subscriptions.size > 0) this.scheduleReconnect(generation);
            }
            if (handle && (generation !== this.generation || this.isClosed)) {
                await handle.close().catch(() => undefined);
            }
        }
    }

    private handleEvent(event: any): void {
        if (event?.topic !== "market" || !event.payload) return;
        const payload = event.payload;
        if (event.type === "last_trade_price") {
            this.processTick(payload.assetId, payload.price, payload.timestamp, event.type);
        } else if (event.type === "book" && payload.lastTradePrice != null) {
            this.processTick(payload.assetId, payload.lastTradePrice, payload.timestamp, "book_snapshot");
        }
    }

    private processTick(assetId: unknown, rawPrice: unknown, rawTimestamp: unknown, eventType: string): void {
        if (typeof assetId !== "string" || !isValidAssetId(assetId)) return;
        const price = Number(rawPrice);
        if (!Number.isFinite(price) || price <= 0 || price >= 1) return;

        const timestamp = rawTimestamp == null ? String(Date.now()) : String(rawTimestamp);
        const hash = `${assetId}:${price}:${timestamp}`;
        if (this.seenHashes.has(hash)) return;
        this.seenHashes.add(hash);
        this.seenHashOrder.push(hash);
        if (this.seenHashOrder.length > this.maxSeenHashes) {
            const oldest = this.seenHashOrder.shift();
            if (oldest) this.seenHashes.delete(oldest);
        }

        try {
            this.onPriceCallback({
                asset_id: assetId,
                price: String(rawPrice),
                timestamp,
                event_type: eventType,
            });
        } catch (error) {
            console.error("[Market stream] Price handler failed:", error);
        }
    }

    private scheduleReconnect(generation: number): void {
        if (this.reconnectTimer || generation !== this.generation) return;
        const backoff = Math.min(30_000, 500 * 2 ** Math.min(this.retryAttempt, 6));
        const jitteredDelay = Math.round(backoff * (0.8 + Math.random() * 0.4));
        this.retryAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (generation === this.generation && !this.isClosed) void this.runSubscription(generation);
        }, jitteredDelay);
    }

    close(): void {
        this.isClosed = true;
        this.isActive = false;
        this.generation++;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        const handle = this.handle;
        this.handle = undefined;
        if (handle) void handle.close().catch((error) => {
            console.warn("[Market stream] Failed to close subscription:", error);
        });
    }
}

function isValidAssetId(assetId: string): boolean {
    return /^\d+$/.test(assetId);
}
