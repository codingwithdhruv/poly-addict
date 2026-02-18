# 🦅 Poly-Addict
> *High-Frequency Prediction Market Trading Suite for Polymarket (Polygon)*

**Poly-Addict** is an institutional-grade algorithmic trading bot engineered for the Polymarket ecosystem. It specializes in volatility harvesting ("The Gabagool"), atomic arbitrage, and market making, backed by robust safety mechanisms including WalletGuard™ and Proxy Integration.

---

## 🚀 Features

### 🧠 Strategic Engines
1.  **The Gabagool (Dip Arbitrage)**
    *   **Logic**: Exploits mean-reversion in binary markets. Accumulates heavily when spreads widen (panic dumps) and exits when they normalize.
    *   **Behavior**: Scans for price drops > 15-25% (configurable) and buys.

2.  **True Pair Arb (Atomic)**
    *   **Logic**: Scans for instant risk-free arbitrage opportunities where `AskYes + AskNo < 1.00`.
    *   **Safety**: Executes atomically or rolls back. Zero directional risk.

3.  **BTC 5m Scalper**
    *   **Logic**: Specialized high-velocity strategy for 5-minute BTC markets.
    *   **Optimized**: Faster scan rates and tighter timing logic for rapid-fire markets.

4.  **Simple Hedge (Neutral Market Making)**
    *   **Logic**: Places dormant limit orders at **$0.35** on both sides (Yes/No) to capture spread and volatility.
    *   **Behavior**: Joins 5-minute markets, places dual orders, and waits for fills. If only one side fills, it manages directional risk.

### 🛡️ Safety Systems
*   **WalletGuard™**: Prevents capital over-commitment by tracking in-flight orders.
*   **Force Hedge**: Automatically neutralizes delta if a leg fails to fill.
*   **Proxy Support**: Native integration for Gnosis Safe / Relayer execution (Gasless).

---

## 📦 Installation

1.  **Clone & Install**
    ```bash
    git clone <repo-url>
    cd poly-addict
    npm install
    ```

2.  **Environment Config**
    Create a `.env` file from `.env.example`:
    ```env
    RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
    PRIVATE_KEY=0xYOUR_PRIVATE_KEY
    # Optional: Proxy
    # POLY_PROXY_ADDRESS=0x...
    ```

3.  **Build**
    ```bash
    npm run build
    ```

---

## 🎮 Quick Start (Recommended)

The bot comes with helper scripts (`./trade` and `./arb`) for easiest execution.

### 1. Trading (`./trade`)
The `./trade` script is the primary entry point for all strategies.

**Syntax:**
```bash
./trade <COIN> [OPTIONS]
```

**Examples:**

```bash
# Standard Dip Buying (ETH)
./trade eth

# Aggressive BTC Dip Buying
./trade btc --dip=0.15 --shares=50

# BTC 5-Minute Scalper Strategy
./trade btc --strategy=btc5m

# Market Making (Simple Hedge)
./trade btc --simple-hedge
```

### 2. Arbitrage (`./arb`)
Scans for risk-free arbs on a specific asset using the Atomic Arb strategy.

**Examples:**
```bash
./arb sol
./arb eth
```

### 3. Dashboard & Utilities

```bash
# Live PnL Dashboard (Standalone)
./trade -dashboard

# Check Wallet Balances
./trade -info

# Redeem All Winnings
./trade -redeem
```

---

## 🔧 Configuration Flags

Full list of command-line arguments supported by `src/config/args.ts`.

| Flag | Description | Default |
| :--- | :--- | :--- |
| **Strategy Selection** | | |
| `--strategy=btc5m` | Selects the 5-minute BTC strategy | - |
| `--simple-hedge` | Selects the Simple Hedge Strategy | - |
| `--arb` | Switch to Atomic Arb Strategy | - |
| **Asset & Pricing** | | |
| `--coin=<COIN>` | Target Asset (BTC, ETH, SOL, XRP) | ETH |
| `--dip=<0.XX>` | Price drop % to trigger buy (0.25 = 25%) | *Var* |
| `--target=<0.XX>` | Sum Target to exit (AvgYes + AvgNo) | 0.96 |
| `--min-profit=<$>` | Min Expected Profit per trade | *Var* |
| `--min-price=<0.XX>` | Minimum price to trade (avoid dust) | 0.06 |
| **Sizing & Risk** | | |
| `--shares=<N>` | Max shares per clip | *Var* |
| `--size=<$>` | Trade size in USD (for supported strategies) | 20 |
| `--timeout=<SEC>` | Max wait before Force Hedge | *Var* |
| **System** | | |
| `--redeem` | Redeem all winning positions and exit | false |
| `--dashboard` | Launch standalone PnL Dashboard | false |
| `--info` | Show wallet balances and exit | false |
| `--verbose` | Enable debug logs | false |

---

## ⚠️ Disclaimer
*Prediction markets are volatile. Use at your own risk. The authors accept no liability for financial losses.*
