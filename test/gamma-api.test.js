import test from "node:test";
import assert from "node:assert/strict";
import { getOutcomeAssetIds } from "../dist/clients/gamma-api.js";

test("Gamma V1 selects CTF token IDs and maps outcome labels", () => {
    const ids = getOutcomeAssetIds({
        version: "v1",
        clobTokenIds: '["101","202"]',
        positionIds: ["999", "1000"],
        outcomes: '["No","Yes"]',
    });
    assert.deepEqual(ids, ["202", "101"]);
});

test("Gamma V2 selects Protocol V2 position IDs", () => {
    const ids = getOutcomeAssetIds({
        version: "v2",
        positionIds: ["651150819117105875331414918119047680898421632356043490229292782433651916800", "651150819117105875331414918119047680898421632356043490229292782433651916801"],
        clobTokenIds: ["101", "202"],
        outcomes: ["Yes", "No"],
    });
    assert.equal(ids[0].endsWith("6800"), true);
    assert.equal(ids[1].endsWith("6801"), true);
});

test("Gamma rejects unknown versions, malformed IDs, and non-binary outcomes", () => {
    assert.equal(getOutcomeAssetIds({ clobTokenIds: ["101", "202"] }), null);
    assert.equal(getOutcomeAssetIds({ version: "v2", positionIds: ["101", "bad"] }), null);
    assert.equal(getOutcomeAssetIds({ version: "v1", clobTokenIds: ["101", "202", "303"] }), null);
    assert.equal(getOutcomeAssetIds({ version: "v1", clobTokenIds: ["101", "202"], outcomes: ["Up", "Down"] }), null);
});
