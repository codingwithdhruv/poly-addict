import test from "node:test";
import assert from "node:assert/strict";
import { ClobClient, Side, normalizeBalanceAllowance } from "../dist/clients/clob.js";

test("CLOB balance and allowance values stay in exact base-unit strings", () => {
    const response = normalizeBalanceAllowance({
        balance: 12345678901234567890n,
        allowances: { "0xoperator": 9007199254740993123n },
    });
    assert.equal(response.balance, "12345678901234567890");
    assert.deepEqual(response.allowances, { "0xoperator": "9007199254740993123" });
});

test("CLOB adapter translates validated limit orders to the unified SDK", async () => {
    const calls = [];
    const sdk = {
        placeLimitOrder: async (request) => {
            calls.push(request);
            return { ok: true, orderId: "order-1", assetId: request.assetId, originalSize: "5", sizeMatched: "0", status: "LIVE" };
        },
    };
    const clob = new ClobClient(sdk, "0xwallet");
    const order = await clob.createAndPostOrder(
        { tokenID: "123", price: 0.42, size: 5, side: Side.BUY },
        { postOnly: true },
    );
    assert.deepEqual(calls, [{ assetId: "123", price: 0.42, size: 5, side: Side.BUY, postOnly: true }]);
    assert.equal(order.orderID, "order-1");
    assert.equal(order.asset_id, "123");
    assert.equal(order.original_size, "5");
    assert.equal(order.success, true);
    assert.equal(order.status, "LIVE");
});

test("CLOB adapter rejects invalid prices, sizes, missing asset IDs, and unsupported order types", async () => {
    let calls = 0;
    const sdk = { placeLimitOrder: async () => { calls++; return {}; } };
    const clob = new ClobClient(sdk, "0xwallet");
    await assert.rejects(clob.createAndPostOrder({ tokenID: "1", price: 1, size: 5, side: Side.BUY }), /Invalid limit price/);
    await assert.rejects(clob.createAndPostOrder({ tokenID: "1", price: 0.5, size: 0, side: Side.BUY }), /Invalid order size/);
    await assert.rejects(clob.createAndPostOrder({ price: 0.5, size: 5, side: Side.BUY }), /requires an asset ID/);
    await assert.rejects(clob.createAndPostOrder({ tokenID: "1", price: 0.5, size: 5, side: Side.BUY }, {}, "FOK"), /Unsupported limit order type/);
    assert.equal(calls, 0);
});

test("redeem and merge actions wait for transaction settlement", async () => {
    const actions = [];
    const sdk = {
        redeemPositions: async (request) => {
            actions.push(["redeem", request]);
            return { wait: async () => ({ transactionHash: "0xredeem" }) };
        },
        mergePositions: async (request) => {
            actions.push(["merge", request]);
            return { wait: async () => ({ transactionHash: "0xmerge" }) };
        },
    };
    const clob = new ClobClient(sdk, "0xwallet");
    assert.deepEqual(await clob.redeemPositions("0xcondition"), { transactionHash: "0xredeem" });
    assert.deepEqual(await clob.mergePositions("0xcondition"), { transactionHash: "0xmerge" });
    assert.deepEqual(actions, [
        ["redeem", { conditionId: "0xcondition" }],
        ["merge", { amount: "max", conditionId: "0xcondition" }],
    ]);
});
