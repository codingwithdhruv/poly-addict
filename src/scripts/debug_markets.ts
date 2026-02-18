import { GammaClient } from "../clients/gamma-api.js";

async function main() {
    const client = new GammaClient();
    const nowSec = Math.floor(Date.now() / 1000);
    const interval = 300;
    const currentSlot = Math.floor(nowSec / interval) * interval;

    // Check current and next 2 slots
    for (let i = 0; i < 3; i++) {
        const ts = currentSlot + (i * interval);
        const slug = `btc-updown-5m-${ts}`;
        console.log(`\n--- Checking Slug: ${slug} ---`);
        try {
            const markets = await client.getMarkets(`slug=${slug}`);
            if (markets.length > 0) {
                const m = markets[0];
                console.log("ID:", m.id);
                console.log("Slug:", m.slug);
                console.log("Closed:", m.closed);
                console.log("EndDate ISO:", m.endDateIso || m.end_date_iso);
                console.log("StartDate ISO:", m.startDateIso || m.start_date_iso);
                console.log("Events[0] Start:", m.events?.[0]?.startDate);
                console.log("Events[0] End:", m.events?.[0]?.endDate);

                const start = new Date(m.events?.[0]?.startDate).getTime();
                const end = new Date(m.events?.[0]?.endDate).getTime();
                const now = Date.now();

                console.log(`Now: ${now}`);
                console.log(`Start: ${start} (Diff: ${(start - now) / 1000}s)`);
                console.log(`End:   ${end} (Diff: ${(end - now) / 1000}s)`);
            } else {
                console.log("Market not found via API.");
            }
        } catch (e) {
            console.error("Error:", e);
        }
    }
}

main();
