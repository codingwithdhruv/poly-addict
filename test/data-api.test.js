import test from "node:test";
import assert from "node:assert/strict";
import { DataApiClient } from "../dist/clients/data-api.js";

const wallet = "0x1234567890123456789012345678901234567890";
const row = (overrides = {}) => ({
    proxy_wallet: wallet,
    token_id: "123",
    condition_id: `0x${"a".repeat(64)}`,
    current_size: 2,
    current_value: 0.8,
    current_price: 0.4,
    status: "OPEN",
    redeemable: false,
    mergeable: false,
    title: "Example market",
    slug: "example-market",
    outcome: "Yes",
    opposite_token_id: "456",
    ...overrides,
});
const page = (data, next_cursor = null) => ({ data, pagination: { limit: 500, offset: 0, has_more: next_cursor !== null, next_cursor } });
const jsonResponse = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });

test("Data API follows opaque cursors and keeps the position query stable", async () => {
    const requested = [];
    const client = new DataApiClient(async (input) => {
        const url = new URL(input);
        requested.push(url);
        return requested.length === 1
            ? jsonResponse(page([row()], "cursor/with+symbols"))
            : jsonResponse(page([row({ token_id: "456" })]));
    });

    const positions = await client.listPositions(wallet, { includeArchived: true, pageSize: 500 });
    assert.equal(positions.length, 2);
    assert.equal(requested.length, 2);
    assert.equal(requested[0].pathname, "/v2/positions");
    assert.equal(requested[0].searchParams.get("status"), "OPEN");
    assert.equal(requested[0].searchParams.get("filter_type"), "TOKENS");
    assert.equal(requested[0].searchParams.get("filter_amount"), "0");
    assert.equal(requested[0].searchParams.get("include_archived"), "true");
    assert.equal(requested[1].searchParams.get("cursor"), "cursor/with+symbols");
    assert.equal(requested[1].searchParams.get("user"), wallet);
});

test("Data API retries a rate limit response", async () => {
    let calls = 0;
    const client = new DataApiClient(async () => {
        calls++;
        return calls === 1
            ? jsonResponse({ error: "busy" }, 429, { "retry-after": "0" })
            : jsonResponse(page([row()]));
    }, "https://data-api.polymarket.com", 1000, 2);
    const positions = await client.listPositions(wallet);
    assert.equal(calls, 2);
    assert.equal(positions.length, 1);
});

test("Data API rejects repeated cursors instead of looping forever", async () => {
    let calls = 0;
    const client = new DataApiClient(async () => {
        calls++;
        return jsonResponse(page([row()], "same-cursor"));
    });
    await assert.rejects(client.listPositions(wallet), /repeated a pagination cursor/);
    assert.equal(calls, 2);
});

test("Data API rejects invalid addresses and malformed position pages", async () => {
    let calls = 0;
    const client = new DataApiClient(async () => {
        calls++;
        return jsonResponse({ data: [row()], pagination: {} });
    });
    await assert.rejects(client.listPositions("not-an-address"), /Invalid Polymarket wallet address/);
    await assert.rejects(client.listPositions(wallet), /invalid positions page/);
    assert.equal(calls, 1);
});

test("Data API surfaces non-retryable service errors", async () => {
    const client = new DataApiClient(async () => jsonResponse({ error: "bad query" }, 400));
    await assert.rejects(client.listPositions(wallet), /Data API 400: bad query/);
});

test("Data API enforces request timeouts and caller cancellation", async () => {
    const timeoutClient = new DataApiClient((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
    }), "https://data-api.polymarket.com", 5, 0);
    await assert.rejects(timeoutClient.listPositions(wallet), /request failed after retries/);

    const controller = new AbortController();
    const cancelClient = new DataApiClient((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
    }), "https://data-api.polymarket.com", 1000, 0);
    const request = cancelClient.listPositions(wallet, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user cancelled")), 5);
    await assert.rejects(request, /user cancelled/);
});
