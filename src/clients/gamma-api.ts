export interface GammaMarket {
    id: string;
    question?: string;
    slug?: string;
    endDate?: string;
    endDateIso?: string;
    end_date_iso?: string;
    active?: boolean;
    closed?: boolean;
    version?: string;
    conditionId?: string;
    condition_id?: string;
    clobTokenIds?: string | string[] | null;
    clob_token_ids?: string | string[] | null;
    positionIds?: string | string[] | null;
    position_ids?: string | string[] | null;
    outcomes?: string | string[] | null;
    assetIds?: string[];
    [key: string]: any;
}

export interface GammaEvent {
    id: string;
    title: string;
    markets: GammaMarket[];
    [key: string]: any;
}

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 10_000;

function parseArray(value: unknown): string[] | null {
    if (Array.isArray(value)) return value.every((item) => typeof item === "string") ? value : null;
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
    } catch {
        return null;
    }
}

/** Select the documented CTF token IDs or Protocol V2 position IDs for trading. */
export function getOutcomeAssetIds(market: GammaMarket | Record<string, any>): string[] | null {
    const version = String(market.version ?? "").toLowerCase();
    const idsValue = version === "v2"
        ? market.positionIds ?? market.position_ids
        : version === "v1"
            ? market.clobTokenIds ?? market.clob_token_ids
            : null;
    const ids = parseArray(idsValue);
    if (!ids || ids.length !== 2 || ids.some((id) => !/^\d+$/.test(id))) return null;

    const labels = parseArray(market.outcomes)?.map((label) => label.trim().toLowerCase());
    if (labels?.length === 2) {
        const yesIndex = labels.findIndex((label) => label === "yes");
        const noIndex = labels.findIndex((label) => label === "no");
        if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) return null;
        return [ids[yesIndex], ids[noIndex]];
    }

    // Binary Gamma markets return IDs in the outcome order, conventionally YES then NO.
    return ids;
}

function queryParams(query: string): URLSearchParams {
    return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

function normalizeMarket(market: GammaMarket): GammaMarket {
    return { ...market, assetIds: getOutcomeAssetIds(market) ?? undefined };
}

export class GammaClient {
    private async getJson<T>(path: string, params: URLSearchParams): Promise<T> {
        const url = new URL(path, GAMMA_API_URL);
        url.search = params.toString();
        let lastError: unknown;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
                if (response.ok) return await response.json() as T;
                const message = `Gamma API ${response.status} ${response.statusText}`;
                if (response.status !== 429 && response.status < 500) {
                    if (response.status === 404) return [] as T;
                    throw new Error(message);
                }
                lastError = new Error(message);
                const retryAfter = Number(response.headers.get("retry-after"));
                const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.min(retryAfter * 1000, 5000)
                    : 250 * 2 ** attempt;
                if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, delayMs));
            } catch (error) {
                lastError = error;
                if (attempt < 2 && !(error instanceof Error && error.message.startsWith("Gamma API 4"))) {
                    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
                } else if (attempt === 2 || (error instanceof Error && error.message.startsWith("Gamma API 4"))) {
                    throw error;
                }
            }
        }

        throw lastError instanceof Error ? lastError : new Error("Gamma API request failed.");
    }

    async getEvents(query: string): Promise<GammaEvent[]> {
        const events = await this.getJson<GammaEvent[]>("/events", queryParams(query));
        if (!Array.isArray(events)) throw new Error("Gamma events response was not an array.");
        return events.map((event) => ({
            ...event,
            markets: Array.isArray(event.markets) ? event.markets.map(normalizeMarket) : [],
        }));
    }

    async getMarkets(query: string): Promise<GammaMarket[]> {
        const markets = await this.getJson<GammaMarket[]>("/markets", queryParams(query));
        if (!Array.isArray(markets)) throw new Error("Gamma markets response was not an array.");
        return markets.map(normalizeMarket);
    }

    async getMarketMetadata(conditionId: string): Promise<GammaMarket | null> {
        const markets = await this.getMarkets(new URLSearchParams({ condition_id: conditionId }).toString());
        return markets.find((market) => (market.conditionId ?? market.condition_id)?.toLowerCase() === conditionId.toLowerCase()) ?? null;
    }

    async getMarketByTokenId(assetId: string): Promise<GammaMarket | null> {
        const clobMarkets = await this.getMarkets(new URLSearchParams({ clob_token_ids: assetId }).toString());
        const match = clobMarkets.find((market) => getOutcomeAssetIds(market)?.includes(assetId));
        if (match) return match;

        const positionMarkets = await this.getMarkets(new URLSearchParams({ position_ids: assetId }).toString());
        return positionMarkets.find((market) => getOutcomeAssetIds(market)?.includes(assetId)) ?? null;
    }

    async getCrypto15MinMarkets(): Promise<string[]> {
        const events = await this.getEvents("active=true&closed=false&limit=500");
        const assets = new Set<string>();
        for (const event of events) {
            const title = (event.title ?? "").toLowerCase();
            const is15Min = /15\s*(m|min|minute)/.test(title);
            const isTargetCrypto = /\b(btc|bitcoin|eth|ethereum|xrp|sol|solana)\b/.test(title);
            if (!is15Min || !isTargetCrypto) continue;
            for (const market of event.markets) {
                if (!market.active || market.closed) continue;
                for (const assetId of market.assetIds ?? []) assets.add(assetId);
            }
        }
        return [...assets];
    }
}
