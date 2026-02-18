# 🦅 Poly-Addict
> *High-Frequency Prediction Market Trading Suite for Polymarket (Polygon)*

**Poly-Addict** is an institutional-grade algorithmic trading bot engineered for the Polymarket ecosystem. It specializes in volatility harvesting ("The Gabagool"), atomic arbitrage, and market making, backed by robust safety mechanisms including WalletGuard™ and Proxy Integration.

---

## 🚀 Features

### 🧠 Strategic Engines
1.  **The Gabagool (Dip Arbitrage)**
    *   **Logic**: Exploits mean-reversion in binary markets. Accumulates heavily when spreads widen (panic dumps) and exits when spreads normalize.
    *   **Best For**: High-volatility events (Election nights, Sporting upsets).

2.  **Simple Hedge (Neutral Market Making)**
    *   **Logic**: Places dormant limit orders (default **$0.35**) on both sides (Yes/No) to capture spread and volatility.
    *   **Behavior**: Joins 5-minute markets, places dual orders, and waits for fills. If only one side fills, it manages directional risk.
    *   **Smart**: Auto-skips stale markets (< 4m30s remaining) and auto-redeems winnings.

3.  **BTC 5m Scalper**
    *   **Logic**: Specialized high-velocity strategy for 5-minute BTC markets.
    *   **Optimized**: Faster scan rates and tighter timing logic for rapid-fire markets.

4.  **True Pair Arb (Atomic)**
    *   **Logic**: Scans for instant risk-free arbitrage opportunities where `AskYes + AskNo < 1.00`.

### 🛡️ Safety Systems
*   **WalletGuard™**: Prevents capital over-commitment by tracking in-flight orders.
*   **Force Hedge**: Automatically neutralizes delta if a leg fails to fill.
*   **Proxy Support**: Native integration for Gnosis Safe / Relayer execution (Gasless).

---

## ⚡️ Quick Copy-Paste Commands

### 🟢 1. Market Making (Simple Hedge)
*Best for passive income on 5m volatility.*
```bash
# Default (35c limit, $20 size)
./trade btc --simple-hedge

# Custom (38c limit, $50 size)
./trade btc --simple-hedge --price=0.38 --size=50
```

### 🔴 2. Dip Buying (Gabagool)
*Best for catching dumps.*
```bash
# Aggressive BTC Dip Buying
./trade btc --dip=0.15 --shares=50
```

### 🔵 3. BTC 5m Scalper
*High freq scalping.*
```bash
./trade btc --strategy=btc5m
```

---

## 🔧 Configuration Flags

### 🌍 Global / System Flags
*Applies to all strategies.*

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--coin=<COIN>` | Target Asset (BTC, ETH, SOL, XRP) | ETH |
| `--redeem` | Redeem all winning positions and exit | false |
| `--dashboard` | Launch standalone PnL Dashboard | false |
| `--info` | Show wallet balances and exit | false |
| `--verbose` | Enable debug logs | false |

### 🤖 Simple Hedge Flags
*Usage: `./trade <COIN> --simple-hedge [FLAGS]`*

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--simple-hedge` | **Activates Simple Hedge Strategy** | - |
| `--price=<0.XX>` | Limit price for both sides (e.g. 0.35 = 35c) | 0.35 |
| `--size=<$>` | Trade size in USD per side | 20 |

### 📉 Dip Arbitrage (Gabagool) Flags
*Usage: `./trade <COIN> [FLAGS]` (Default Strategy)*

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--dip=<0.XX>` | Price drop % to trigger buy (0.25 = 25%) | *Var* |
| `--target=<0.XX>` | Sum Target to exit (AvgYes + AvgNo) | 0.96 |
| `--shares=<N>` | Max shares per clip | *Var* |
| `--timeout=<SEC>` | Max wait before Force Hedge | *Var* |
| `--min-profit=<$>` | Min Expected Profit per trade | *Var* |
| `--min-price=<0.XX>` | Minimum price to trade (avoid dust) | 0.06 |

### ⚡ BTC 5m Scalper Flags
*Usage: `./trade btc --strategy=btc5m`*

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--strategy=btc5m` | **Activates BTC 5m Scalper** | - |
| `--early-exit` | Enable early exit logic (if huge profit) | true |

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
    ```

3.  **Build**
    ```bash
    npm run build
    ```

---

## ⚠️ Disclaimer
*Prediction markets are volatile. Use at your own risk. The authors accept no liability for financial losses.*
