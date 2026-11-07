# Poly-Addict

Poly-Addict is a TypeScript trading bot for Polymarket short-duration markets. It includes several market-making, hedge, mean-reversion, and pair-arbitrage strategies. The strategies are experimental and can lose money; review their sizing and order logic before enabling live trading.

## Requirements

- Node.js 24 or newer
- A Polygon RPC URL
- An EOA private key for trading or position maintenance
- A Polymarket account wallet address when trading through a proxy/deposit wallet

## Setup

```sh
npm ci
cp .env.example .env
# Edit .env, then compile
npm run build
```

`PRIVATE_KEY` is required to sign orders and maintenance transactions. `POLY_PROXY_ADDRESS` is optional; when set, trading uses that Polymarket account wallet, and the redeem command checks both the account wallet and the EOA. `RELAYER_API_KEY` and `RELAYER_API_KEY_ADDRESS` are optional credentials for supported relayer flows. Use a Polygon RPC provider you trust and configure backup endpoints as `RPC_URL_1` through `RPC_URL_5`.

## Run

The `trade` and `arb` wrappers use the locally installed TypeScript runner:

```sh
./trade btc --strategy reversion --tradeSizeUsd 2
./trade btc --dynamic-hedge --price 35 --shares 10
./arb btc --shares 10
./trade --dashboard
./trade --redeem
```

You can also start the entry point directly:

```sh
npm run dev -- --btc --strategy reversion
npm start -- --btc --strategy reversion
```

The bot supports the BTC, ETH, SOL, and XRP markets. Strategy selection includes `reversion`, `wick-drift`, `dynamic-hedge`, `recursive-dynamic`, `simple-hedge`, `usa-session`, `btc5m`, and `true-arb` (through `./arb`). Order sizing and minimums depend on the market and current Polymarket rules; the bot validates price and size before submission.

## Position maintenance

`./trade --redeem` reads open positions from Data API v2, follows its cursor pagination, and uses the unified Polymarket SDK to redeem resolved positions or merge complementary holdings. Use a separate funded RPC wallet configuration before running it live; transactions may be submitted. The dashboard reads pUSD balances on Polygon and current position values from Data API v2.

## Current Polymarket integration

- Authenticated CLOB, order book, account actions, and managed market subscriptions use `@polymarket/client`.
- Gamma market discovery uses the market version to select the correct trading IDs: CTF token IDs for V1 and position IDs for Protocol V2.
- Portfolio reads use the cursor-paginated Data API v2.
- pUSD is used as the current collateral token and has six decimals.

## Development and checks

```sh
npm run build
npm test
npm audit
```

`npm test` runs the offline unit suite after compiling. The suite does not submit orders or transactions. Live order and transaction behavior still depends on wallet configuration, RPC reliability, current market state, and Polymarket service availability.

Historical tick analysis can be run with:

```sh
npx tsx src/scripts/analyze.ts
```
