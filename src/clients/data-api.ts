export type PositionStatus = "OPEN" | "REDEEMABLE" | "REDEEMABLE_LOST" | "MERGEABLE" | "CLOSED";

export interface PolymarketPosition {
    proxy_wallet: string;
    token_id: string;
    condition_id: string;
    current_size: number;
    current_value: number;
    current_price: number;
    status: string;
    redeemable: boolean;
    mergeable: boolean;
    title: string;
    slug: string;
    outcome: string;
    opposite_token_id: string;
    [key: string]: unknown;
}

export interface ListPositionsOptions {
    status?: PositionStatus;
    includeArchived?: boolean;
    filterAmount?: number;
    pageSize?: number;
    signal?: AbortSignal;
}

type FetchLike = typeof fetch;

/** Client for Polymarket's current cursor-paginated Data API. */
export class DataApiClient {
    constructor(
        private readonly fetchImpl: FetchLike = fetch,
        private readonly baseUrl = "https://data-api.polymarket.com",
        private readonly timeoutMs = 10_000,
        private readonly maxRetries = 3,
    ) {}

    async listPositions(user: string, options: ListPositionsOptions = {}): Promise<PolymarketPosition[]> {
        if (!/^0x[0-9a-f]{40}$/i.test(user)) throw new Error(`Invalid Polymarket wallet address: ${user}`);
        const pageSize = options.pageSize ?? 500;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
            throw new Error("Data API pageSize must be an integer from 1 to 1000.");
        }
        const filterAmount = options.filterAmount ?? 0;
        if (!Number.isFinite(filterAmount) || filterAmount < 0) {
            throw new Error("Data API filterAmount must be a finite non-negative number.");
        }

        const positions: PolymarketPosition[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;

        // The cap protects the caller if a malformed server response repeats pages indefinitely.
        for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
            const url = new URL("/v2/positions", this.baseUrl);
            url.searchParams.set("user", user);
            url.searchParams.set("status", options.status ?? "OPEN");
            url.searchParams.set("filter_type", "TOKENS");
            url.searchParams.set("filter_amount", String(filterAmount));
            url.searchParams.set("include_archived", String(options.includeArchived ?? false));
            url.searchParams.set("limit", String(pageSize));
            if (cursor) url.searchParams.set("cursor", cursor);

            const response = await this.fetchWithRetry(url, options.signal);
            const payload = await response.json() as {
                data?: unknown;
                pagination?: { next_cursor?: unknown };
                error?: string;
            };
            if (!response.ok) {
                throw new Error(`Polymarket Data API ${response.status}: ${payload?.error ?? response.statusText}`);
            }
            if (!payload || !Array.isArray(payload.data) || !payload.pagination || !("next_cursor" in payload.pagination)) {
                throw new Error("Polymarket Data API returned an invalid positions page.");
            }
            for (const row of payload.data) {
                if (!isPosition(row)) throw new Error("Polymarket Data API returned a malformed position row.");
                positions.push(row);
            }

            const next = payload.pagination.next_cursor;
            if (next === null || next === undefined || next === "") return positions;
            if (typeof next !== "string") throw new Error("Polymarket Data API returned an invalid pagination cursor.");
            if (seenCursors.has(next)) throw new Error("Polymarket Data API repeated a pagination cursor.");
            seenCursors.add(next);
            cursor = next;
        }
        throw new Error("Polymarket Data API exceeded the 10,000-page safety limit.");
    }

    private async fetchWithRetry(url: URL, callerSignal?: AbortSignal): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (callerSignal?.aborted) throw callerSignal.reason ?? new Error("Request aborted.");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(new Error("Polymarket Data API request timed out.")), this.timeoutMs);
            const relayAbort = () => controller.abort(callerSignal?.reason);
            callerSignal?.addEventListener("abort", relayAbort, { once: true });
            try {
                const response = await this.fetchImpl(url, { signal: controller.signal });
                if (![429, 500, 502, 503, 504].includes(response.status) || attempt === this.maxRetries) return response;
                lastError = new Error(`Polymarket Data API returned ${response.status}.`);
                await response.body?.cancel().catch(() => undefined);
                await sleep(retryDelayMs(response.headers.get("retry-after"), attempt), callerSignal);
            } catch (error) {
                if (callerSignal?.aborted) throw callerSignal.reason ?? error;
                lastError = error;
                if (attempt === this.maxRetries) break;
                await sleep(backoffMs(attempt), callerSignal);
            } finally {
                clearTimeout(timeout);
                callerSignal?.removeEventListener("abort", relayAbort);
            }
        }
        throw new Error(`Polymarket Data API request failed after retries: ${errorMessage(lastError)}`);
    }
}

function isPosition(value: unknown): value is PolymarketPosition {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return typeof row.condition_id === "string"
        && typeof row.token_id === "string"
        && typeof row.current_size === "number"
        && typeof row.redeemable === "boolean"
        && typeof row.mergeable === "boolean";
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
    }
    return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
    return Math.min(250 * 2 ** attempt, 4_000) + Math.floor(Math.random() * 100);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted."));
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
        };
        const done = () => {
            cleanup();
            resolve();
        };
        const onAbort = () => {
            cleanup();
            reject(signal?.reason ?? new Error("Request aborted."));
        };
        const timeout = setTimeout(done, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
