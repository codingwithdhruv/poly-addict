# 🛡️ Poly-Addict: High-Performance Polymarket Trading Suite

A "God-Tier" trading suite for Polymarket, optimized for low-latency market data, gasless transaction execution, and seamless multi-market rotation. 

Built with a **WebSocket Swarm** (50+ connections) and **Relayer V2** integration for zero-gas maintenance.

---

## 🚀 Quick Start

### 1. Installation & Build
```bash
npm install
npm run build
```

### 2. Environment Setup
Create a `.env` file in the root directory (refer to `.env.example`):
```env
PK=YOUR_EOA_PRIVATE_KEY
POLY_API_KEY=YOUR_BUILDER_API_KEY
POLY_API_SECRET=YOUR_BUILDER_API_SECRET
POLY_API_PASSPHRASE=YOUR_BUILDER_PASSPHRASE
POLY_PROXY_ADDRESS=YOUR_PROXY_WALLET_ADDRESS
RELAYER_API_KEY=YOUR_RELAYER_API_KEY
RELAYER_API_KEY_ADDRESS=0x... (EOA Address)
```

### 3. Execution Shortcuts (Recommended)
The fastest way to run the bot is using the included shell wrappers:
```bash
chmod +x trade arb
./trade btc          # Starts default 15m Dip/Arb for BTC
./arb eth            # Starts True Pair Arb for ETH
```

---

## 🐚 Master Shell Utility Guide

These scripts are the primary way to interact with the bot. They bypass slow build checks and automate flag construction.

### 📈 The `trade` Script (`./trade`)
Used for all standard directional and volatility strategies.

**Core Syntax:**
```bash
./trade <coin> [optional_flags]
```

**Features:**
- **Auto-Normalization**: Accepts `btc`, `BTC`, `--btc`, or `-btc` interchangeably.
- **Integrated Maintenance**: Quick access to bot tools using the coin slot:
    - `./trade -info`      : View balance and API status.
    - `./trade -redeem`    : Manual gasless redemption.
    - `./trade -dashboard` : Start the live PnL dashboard.

**Common Examples:**
```bash
./trade btc --btc5m          # BTC 5m Volatility (High Frequency)
./trade eth --shares=50      # ETH 15m Dip Arbs with custom size
./trade xrp --simple-hedge   # XRP 5m Fixed Price Hedging (35c default)
```

### ⚖️ The `arb` Script (`./arb`)
Specifically designed for the **True Pair Arbitrage** strategy. It forces the `-arb` flag and sets the strategy to `Generic15mPairArbStrategy`.

**Core Syntax:**
```bash
./arb <coin> [optional_flags]
```

**Common Examples:**
```bash
./arb btc                    # Standard BTC 15m Pair Arb
./arb eth --target=0.97      # Aggressive ETH Arb (Entry @ $0.97 cost)
```

---

## 🛠 Trading Strategy Reference

| Flag | Strategy Name | Timeframe | Description |
| :--- | :--- | :--- | :--- |
| `(default)` | **Generic 15m Dip/Arb** | 15m | The master strategy. Uses weighted averages to enter on price "dips". |
| `--btc5m` | **BTC 5m Volatility** | 5m | Ultra high-frequency trading for fast-moving 5-minute markets. |
| `--arb` | **Generic 15m Pair Arb** | 15m | Pure logical arbitrage. Enters when Yes + No cost combined < $1.00. |
| `--simple-hedge`| **BTC 5m Fixed Hedge** | 5m | Yield-focused. Places resting limit orders (e.g. 35c) to capture premiums. |
| `--usa-session` | **BTC 15m Extreme** | 15m | "Fat-finger" hunter. Places 1c buy orders to catch outlier fills. |

---

## ⚙️ Advanced Parameter Tuning

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--dip=0.15` | `0.15` | Size of the dip required to trigger an entry (0.15 = 15% drop). |
| `--shares=10` | `10` | Number of shares to purchase per "tick" of opportunity. |
| `--target=0.95`| `0.95`| The Max Pair Cost (YES+NO) to stop buying. |
| `--window=3000` | `3000` | Sliding window in ms for weighted average calculation. |
| `--timeout=60` | `60` | Seconds to wait for leg 2 before forcing a hedge. |
| `--price=35` | `35` | Fixed price in cents for `--simple-hedge` or `--usa-session`. |

---

## 📊 Maintenance & Debugging

### One-off Redemption
```bash
./trade -redeem
```
*Note: The bot also auto-redeems in the background every 60s during sessions.*

### Live Dashboard
```bash
./trade -dashboard
```

### Market Debugger
If you notice skipped markets, use the standalone debugger to check Gamma API sync:
```bash
npm run dev -- src/scripts/debug_markets.ts
```

---

## ⚡ Features
- **50+ WebSocket Swarm**: Low-latency data with jitter-reaper protection.
- **Lazy Loading (Pre-Warming)**: Proactively connects to the *next* market 30s early for zero-gap trading.
- **Atomic Entry Locks**: Mutex-protected tick processing to prevent "Double Buys."
- **Gasless Relayer V2**: Compliance with official Gnosis Safe EIP-712 domains.

---

## ⚠️ Disclaimer
This is experimental software. Trading carries risk. Always test with small sizes first.
