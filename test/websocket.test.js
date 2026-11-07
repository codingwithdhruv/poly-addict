import test from "node:test";
import assert from "node:assert/strict";
import { PriceSocket } from "../dist/clients/websocket.js";

class EventQueue {
    items = [];
    waiters = [];
    closed = false;

    [Symbol.asyncIterator]() { return this; }

    next() {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    push(value) {
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value, done: false });
        else this.items.push(value);
    }

    async return() {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
        return { value: undefined, done: true };
    }
}

const tick = (type, payload) => ({ topic: "market", type, payload });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("managed market stream validates IDs, filters event types, and deduplicates ticks", async () => {
    const received = [];
    const queue = new EventQueue();
    let subscribedIds;
    const client = {
        subscribeMarket: async (assetIds) => {
            subscribedIds = assetIds;
            return { ...queue, close: () => queue.return(), [Symbol.asyncIterator]: () => queue };
        },
    };
    const socket = new PriceSocket((update) => received.push(update));
    socket.setClient(client);
    socket.connect(["123", "bad-id"]);
    await flush();
    assert.deepEqual(subscribedIds, ["123"]);
    assert.equal(socket.isConnected(), true);

    queue.push(tick("last_trade_price", { assetId: "123", price: "0.43", timestamp: "10" }));
    queue.push(tick("last_trade_price", { assetId: "123", price: "0.43", timestamp: "10" }));
    queue.push(tick("book", { assetId: "123", lastTradePrice: "0.51", timestamp: "11" }));
    queue.push(tick("last_trade_price", { assetId: "123", price: "1", timestamp: "12" }));
    queue.push({ topic: "user", type: "last_trade_price", payload: { assetId: "123", price: "0.2", timestamp: "13" } });
    await flush();

    assert.equal(received.length, 2);
    assert.deepEqual(received.map((item) => [item.price, item.event_type]), [
        ["0.43", "last_trade_price"],
        ["0.51", "book_snapshot"],
    ]);
    socket.close();
    assert.equal(socket.isConnected(), false);
});

test("market stream subscription changes restart with the expanded asset set", async () => {
    const queues = [];
    const subscribed = [];
    const client = {
        subscribeMarket: async (assetIds) => {
            const queue = new EventQueue();
            queues.push(queue);
            subscribed.push(assetIds);
            return { ...queue, close: () => queue.return(), [Symbol.asyncIterator]: () => queue };
        },
    };
    const socket = new PriceSocket(() => {});
    socket.setClient(client);
    socket.connect(["123"]);
    await flush();
    socket.subscribe(["456", "456", "bad-id"]);
    await flush();
    assert.deepEqual(subscribed, [["123"], ["123", "456"]]);
    assert.equal(queues[0].closed, true);
    socket.close();
});
