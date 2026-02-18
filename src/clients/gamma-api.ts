export interface GammaMarket {
    id: string;
    question: string;
    market_slug: string;
    end_date_iso: string;
    active: boolean;
    clob_token_ids: string[];
}

export interface GammaEvent {
    id: string;
    title: string;
    markets: GammaMarket[];
}

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

export class GammaClient {
    async getEvents(queryParams: string): Promise<GammaEvent[]> {
        const url = `${GAMMA_API_URL}/events?${queryParams}`;
        console.log(`Fetching Gamma Events: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Gamma API Error: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    }

    async getMarkets(queryParams: string): Promise<any[]> {
        const url = `${GAMMA_API_URL}/markets?${queryParams}`;
        console.log(`Fetching Gamma Markets: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            // 404 is common if the predictive slug doesn't exist yet
            if (response.status === 404) return [];
            throw new Error(`Gamma API Error: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    }

    async getCrypto15MinMarkets(): Promise<string[]> {
        // Fetch ALL active markets to avoid tag issues
        const events = await this.getEvents("active=true&closed=false");
        console.log(`Fetched ${events.length} total active events.`);

        const targetAssets: string[] = [];
        const now = new Date();

        for (const event of events) {
            // Filter logic for 15 min markets? 
            // Usually titles contain "Bitcoin >$100k (15min)" or similar, or we check duration?
            // User requested "15min BTC/ETH/XRP". 
            // Often these markets have "15min" in the title or question.

            // Heuristic: Check if title contains "15min" or "15m" (case insensitive)
            // AND contains BTC, ETH, or XRP
            const title = event.title.toLowerCase();
            // Debug log first few titles
            console.log("Seen Event:", title);

            // Relaxed Filter: Checks for "15" AND ("min" or "m") to catch "15min", "15 min", "15m"
            // Also explicitly check for specific crypto keywords
            const is15Min = (title.includes("15") && (title.includes("min") || title.includes("m")));

            const coins = ["btc", "bitcoin", "eth", "ethereum", "xrp", "sol", "solana"];
            const isTargetCrypto = coins.some(c => title.includes(c));

            if (is15Min && isTargetCrypto) {
                for (const market of event.markets) {
                    // Only active markets
                    if (market.active) {
                        // Assuming "Yes" and "No" tokens. We usually trade active items.
                        // clob_token_ids usually has 2 IDs [Yes, No].
                        // We want to track both? Or just Yes?
                        // User script: "executeBuy" -> usually Yes?
                        // Let's track ALL token IDs for these markets.
                        targetAssets.push(...market.clob_token_ids);
                    }
                }
            }
        }

        return targetAssets;
    }
}
