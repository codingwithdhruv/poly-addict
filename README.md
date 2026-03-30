# 🛡️ Poly-Addict: High-Performance Polymarket Trading Suite

A "God-Tier" trading suite for Polymarket, optimized for low-latency market data, gasless transaction execution, and seamless autonomous multi-market rotation. 

Built with a **WebSocket Swarm** (50+ connections) and **Relayer V2** integration for zero-gas maintenance, Poly-Addict acts as an unyielding liquidity provider and arbitrageur across Polymarket's ultra-short term (5m / 15m) markets.

---

## 🚀 Quick Start

### 1. Installation & Build
```bash
npm install
npm run build
```

### 2. Environment Setup
Create a `.env` file in the root directory:
```env
# EOA / Wallet Config
PRIVATE_KEY=YOUR_EOA_PRIVATE_KEY
POLY_PROXY_ADDRESS=YOUR_PROXY_WALLET_ADDRESS

# Trading API (CTF Builder)
POLY_BUILDER_API_KEY=YOUR_BUILDER_API_KEY
POLY_BUILDER_SECRET=YOUR_BUILDER_API_SECRET
POLY_BUILDER_PASSPHRASE=YOUR_BUILDER_PASSPHRASE

# Gasless Trading (Relayer V2)
RELAYER_API_KEY=YOUR_RELAYER_API_KEY
RELAYER_API_KEY_ADDRESS=0x... (EOA Address)
```

### 3. Execution Shortcuts
The fastest way to run the bot is using the included shell wrapper:
```bash
chmod +x trade
./trade btc --dashboard      # Start the dual-balance portfolio tracker
./trade btc --wick-drift     # Start the flagship Wick Drift algorithm
```

---

## 🐚 Master Shell Utility Guide

The `./trade` command is the primary entrypoint for the suite, bypassing slow build checks and automating flag logic. 

**Core Syntax:**
```bash
./trade <coin> [optional_flags]
```

### Universal Configuration Flags
Regardless of which strategy you run, the following constraints and settings apply:

| Flag | Description | Polymarket Rules |
| :--- | :--- | :--- |
| `--shares=<N>` | Fixed number of shares to buy per leg. | **Must be $\geq$ 5** (Polymarket CLOB Minimum constraint). |
| `--size=<N>` | Dollar value (`USDC`) to allocate per leg. | Bot automatically floors size to 5 shares if this implies $< 5$. |
| `--price=<C>` | Target entry price (in cents, e.g. `35` = $0.35). | Cannot exceed `100` (=$1.00). Used by sniper/hedge strategies. |
| `--cooldown=<M>`| Minutes to wait if the bot fails consecutive hedges. | Default is `10` minutes. |

---

## 🛠 Trading Strategy Reference Guides

### 1. Wick Drift (Recursive Sniper) `[NEW]`
**Flag:** `--wick-drift`
**Timeframe:** 5M
**Description:** The most advanced flagship strategy. Places deep limit orders (wicks) below the midpoint. If hit, it assumes a temporary market dislocation and immediately "drifts" a break-even hedge order onto the opposing book while aiming for a fixed USD profit. If the market isn't resolving within 60s, it aggressively moves the hedge order to break-even to prevent naked directional exposure. Can recursively trigger up to 3 times per 5-minute window if volatility is extreme.
**Command:**
```bash
# Aim for 35c entries, lock in guaranteed profit, 5 shares per cycle
./trade btc --wick-drift --price=35 --shares=5
```

### 2. Dynamic Hedge (Leg-In Maker) `[NEW]`
**Flag:** `--dynamic-hedge`
**Timeframe:** 5M
**Description:** A liquidity provisioning system. It bids passively on *both* YES and NO tokens simultaneously at low prices. The moment one side is randomly filled ("Legs In"), it cancels the opposing order and calculates the exact price required to "Hedge Out" for a fixed 5c profit spread, walking the order up as time runs out.
**Command:**
```bash
# Bid 35c simultaneously on YES and NO, dynamically hedge the remainder
./trade eth --dynamic-hedge --price=35 --shares=10
```

### 3. Fixed Hedge (Yield Farmer)
**Flag:** `--simple-hedge`
**Timeframe:** 5M
**Description:** The simplest yield generation bot. Posts passive limit orders at exactly `Price X` on both sides. Assuming a `35c` limit, if the market whipsaws and hits *both* sides, you spend 70c to guarantee a $1.00 payout (+30c profit). If only one side hits, the position carries to expiry.
**Command:**
```bash
# Post 35c limits across the board
./trade sol --simple-hedge --price=35 --size=20
```

### 4. Mean Reversion (Fat-Finger Hunter)
**Flag:** `--usa-session` or `--mean-reversion`
**Timeframe:** 15m
**Description:** Specifically tuned for massive liquidity gaps. Places `1c` or `5c` buy orders and simply waits for a user to market-sell into the void. Completely passive.

### 5. Dip-Arb (The Original)
**Flag:** `(default)`
**Timeframe:** 15m
**Description:** The legacy system. Scans the real-time WebSocket firehose. If the price drops by $X\%$ (e.g. 15%) within a strict 3-second rolling window, it market-buys into the panic. Uses a weighted cost basis to exit at a specified target sum.
**Command:**
```bash
# Enter if price drops 15%, buy 10 shares
./trade btc --dip=0.15 --shares=10
```

---

## 📊 The Trading HUD & Observability

The bot features a standalone Terminal-based dashboard that aggregates the live PnL of all running strategies and syncs actual blockchain token balances.

**Command:**
```bash
./trade -dashboard
```

**Features:**
- **On-Chain Accuracy**: Bypasses the CLOB cache, using standard RPC queries on the Polygon USDC.e contract to fetch exact precision values.
- **Dual Wallet Tracking**: Specifically renders Capital allocated to the Smart Wallet (Proxy) distinct from your Gas (EOA) wallet.
- **Portfolio Aggregation**: Polls the Polymarket open-positions API to aggregate the exact real-time net-liquidation value of all your active hedges onto the dashboard.

---

## ⚡ Technical Architecture Highlights
- **WhatsApp/Socket Swarm**: Jitter-reaper routines load-balance 50+ concurrent websocket subscriptions to prevent API ban-hammering.
- **Pre-Warming**: Subscribes to Token IDs for market *T+1* while market *T* is in its final 30 seconds to ensure 0ms gap in bid placements.
- **Mutex Tick Processing**: Locks individual token-pair processing at the millisecond level to prevent "Double Buys" during extreme volume spasms.
- **Gasless Native API**: Full EIP-712 typed-signature integration with Relayer V2, automatically merging opposite positions into USDC to negate settlement fees.

---
## ⚠️ Disclaimer
This is highly experimental autonomous HFT software. Always test strategies with `--shares=5` (the lowest possible limit) before allocating larger USD sizes. Trading carries significant risk.
