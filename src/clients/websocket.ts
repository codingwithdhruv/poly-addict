import WebSocket from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface PriceUpdate {
    asset_id: string;
    price: string;
    timestamp: string;
    event_type: string;
}

export class PriceSocket {
    private ws?: WebSocket;
    private subscriptions: string[] = [];
    private onPriceCallback?: (update: PriceUpdate) => void;

    constructor(onPrice: (update: PriceUpdate) => void) {
        this.onPriceCallback = onPrice;
    }

    connect(assetIds: string[]) {
        if (assetIds.length === 0) {
            console.log("No assets to subscribe to.");
            return;
        }

        this.subscriptions = assetIds;
        this.ws = new WebSocket(WS_URL);

        this.ws.on("open", () => {
            console.log("WebSocket connected. Subscribing...");
            const msg = {
                type: "market",
                assets_ids: this.subscriptions,
            };
            this.ws?.send(JSON.stringify(msg));
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
            try {
                const parsed = JSON.parse(data.toString());
                // Filter for last_trade_price events
                if (parsed.event_type === "last_trade_price") {
                    if (this.onPriceCallback) {
                        this.onPriceCallback(parsed);
                    }
                }
            } catch (e) {
                console.error("WS Parse error:", e);
            }
        });

        this.ws.on("error", (err) => {
            console.error("WebSocket error:", err);
        });

        this.ws.on("close", () => {
            console.log("WebSocket closed. Reconnecting in 5s...");
            setTimeout(() => this.connect(this.subscriptions), 5000);
        });
    }

    close() {
        this.ws?.close();
    }
}
