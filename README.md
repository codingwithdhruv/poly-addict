# 🛡️ Poly-Addict: High-Performance Polymarket Trading Suite

A "God-Tier" trading suite for Polymarket, optimized for low-latency market data, gasless transaction execution, and seamless autonomous multi-market rotation. 

Built with a **WebSocket Swarm** and **Relayer V2** integration, Poly-Addict acts as an unyielding liquidity provider and arbitrageur across Polymarket's ultra-short term (5m / 15m) markets.

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
./trade -dashboard           # Start the dual-balance portfolio tracker
./trade btc --recursive-dynamic --shares 10 # Start the Flagship Hedge Bot
```

---

## 🐚 Master Shell Utility Guide

The `./trade` command is the primary entrypoint for the suite, automating flag logic. 

**Core Syntax:**
```bash
./trade <coin> [optional_flags]
```

### Universal Configuration Flags
| Flag | Description | Default | 
| :--- | :--- | :--- |
| `--shares=<N>` | Fixed number of shares per leg (Polymarket min: 5). | 5 |
| `--price=<C>` | Target entry price (e.g. `0.35` = $0.35). | 0.35 |
| `--stop-loss=<S>` | Absolute sum limit (e.g. `1.15`). If YES+NO cost > S, exit. | 1.15 |
| `--cooldown=<M>`| Minutes to wait after consecutive failures. | 10 |

---

## 🛠 Trading Strategy Reference Guides

### 1. Recursive Dynamic Hedge `[FLAGSHIP]`
**Flag:** `--recursive-dynamic`
**Timeframe:** 5M
**Description:** The current state-of-the-art strategy. It bids passively at your target entry (e.g., 35c). Once one side fills, it immediately "Legs-In" to the opposite side to lock in a guaranteed profit spread. Unlike basic hedging, this version supports **Infinite Cycles** per market window—locking in profit and then immediately resetting for a new round if time permits.
**Safety**: Includes an automated **Stop-Loss Circuit Breaker** to prevent chasing expensive hedges during parabolic trends.
**Command:**
```bash
./trade btc --recursive-dynamic --shares 10 --price 35 --sl 1.12
```

### 2. Noise Reversion (Market Maker)
**Flag:** `--reversion`
**Timeframe:** 5M
**Description:** Calculates a dynamic 20-tick EMA. Floats Buy orders at `EMA - Offset`. Acts as a liquidity provider to capture micro-spasms.
**Command:**
```bash
./trade btc --reversion --tradeSizeUsd 5
```

### 3. Wick Drift (Recursive Sniper)
**Flag:** `--wick-drift`
**Timeframe:** 5M
**Description:** Places deep limit orders below the midpoint. If hit, it assumes a temporary market dislocation and immediately hedges the opposing book for a profit.
**Command:**
```bash
./trade btc --wick-drift --price 35 --shares 5
```

### 4. Dynamic Hedge (Leg-In Maker)
**Flag:** `--dynamic-hedge`
**Timeframe:** 5M
**Description:** Bids passively on both YES/NO. Once filled, it calculates the required hedge price to net a profit and "walks" the order up.
**Command:**
```bash
./trade btc --dynamic-hedge --price 35 --shares 10
```

### 5. Fixed Hedge (Yield Farmer)
**Flag:** `--simple-hedge`
**Timeframe:** 5M
**Description:** Posts passive limit orders at a fixed price on both sides. If market volatility hits both, a 30c+ net profit is guaranteed.

### 6. Mean Reversion & Dip-Arb
**Flags:** `--usa-session` (15m) / `--dip` (15m)
**Description:** Strategies tuned for liquidity gaps and massive 15-20% dumps. 

---

## 📊 The Trading HUD & Observability

The bot features a standalone Terminal-based dashboard that aggregates the live PnL of all running strategies and syncs actual blockchain token balances.

**Command:**
```bash
./trade -dashboard
```

**Features:**
- **On-Chain Accuracy**: Uses standard RPC queries on the Polygon USDC.e contract.
- **Dual Wallet Tracking**: Renders Proxy (Strategy) and EOA (Gas) balances separately.
- **Portfolio Aggregation**: Aggregates real-time net-liquidation value of all active positions.

---

## ⚡ Technical Architecture Highlights
- **WebSocket Swarm**: Jitter-reaper routines manage staggered worker connections to ensure sub-10ms snapshot delivery.
- **Stop-Loss Circuit Breaker**: Strategic "Safety Fuse" that terminates round exposure if market move exceeds profitable bounds.
- **PnL Mutex Tracking**: High-precision accounting that tracks `roundInitialSize` to ensure PnL is accurate even with recursive partial fills.
- **Gasless Native API**: Full EIP-712 typed-signature integration with Relayer V2 for zero-fee maintenance.

---
## ⚠️ Disclaimer
This is highly experimental autonomous HFT software. Always test strategies with minimum sizes before allocating larger USDC amounts. Trading carries significant risk.
