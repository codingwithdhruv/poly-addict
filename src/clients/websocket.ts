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

        // Close existing connection if any
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) { }
        }

        this.subscriptions = assetIds;
        const ws = new WebSocket(WS_URL);
        this.ws = ws;

        ws.on("open", () => {
            console.log("WebSocket connected. Subscribing...");
            if (ws.readyState === WebSocket.OPEN) {
                const msg = {
                    type: "market",
                    assets_ids: this.subscriptions,
                };
                try {
                    ws.send(JSON.stringify(msg));
                } catch (err) {
                    console.error("WS Send error:", err);
                }
            }
        });

        ws.on("message", (data: WebSocket.RawData) => {
            try {
                const strData = data.toString();
                // Handle non-JSON keep-alives or errors if necessary
                if (!strData.trim().startsWith("{")) {
                    // console.debug("WS Received non-JSON:", strData);
                    return;
                }
                const parsed = JSON.parse(strData);
                // Filter for last_trade_price events
                if (parsed.event_type === "last_trade_price") {
                    if (this.onPriceCallback) {
                        this.onPriceCallback(parsed);
                    }
                }
            } catch (e) {
                // Suppress noisy JSON errors for "INVALID OPERATION" etc if they persist
                // console.error("WS Parse error:", e);
            }
        });

        ws.on("error", (err) => {
            console.error("WebSocket error:", err);
        });

        ws.on("close", () => {
            // Only reconnect if this is still the active socket
            if (this.ws === ws) {
                console.log("WebSocket closed. Reconnecting in 5s...");
                setTimeout(() => this.connect(this.subscriptions), 5000);
            }
        });
    }

    close() {
        this.ws?.close();
    }
}
