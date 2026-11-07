import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../dist/config/args.js";

function parseFor(argv) {
    const original = process.argv;
    process.argv = [process.execPath, "main.js", ...argv];
    try {
        return parseCliArgs();
    } finally {
        process.argv = original;
    }
}

test("CLI accepts strategy names in both separated and equals forms", () => {
    assert.equal(parseFor(["--eth", "--strategy", "dynamic-hedge"]).strategy, "dynamic-hedge");
    assert.equal(parseFor(["--eth", "--strategy=wick-drift"]).strategy, "wick-drift");
    assert.equal(parseFor(["--eth", "--strategy", "simple-hedge"]).strategy, "simple-hedge");
    assert.equal(parseFor(["--eth", "--strategy", "btc5m"]).strategy, "btc5m");
});

test("CLI strategy aliases take precedence and retain existing modes", () => {
    assert.equal(parseFor(["--eth", "--dynamic-hedge"]).strategy, "dynamic-hedge");
    assert.equal(parseFor(["--eth", "--strategy", "reversion"]).strategy, "reversion");
    assert.equal(parseFor(["--eth", "--strategy", "mean-reversion"]).strategy, "usa-session");
    assert.equal(parseFor(["--eth", "--arb"]).strategy, "true-arb");
});
