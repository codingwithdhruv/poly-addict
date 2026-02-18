# 🦅 Poly-Addict
> *High-Frequency Prediction Market Trading Suite for Polymarket (Polygon)*

**Poly-Addict** is an institutional-grade algorithmic trading bot engineered for the Polymarket ecosystem. It specializes in volatility harvesting ("The Gabagool"), atomic arbitrage, and market making, backed by robust safety mechanisms including WalletGuard™ and Proxy Integration.

---

## ⚡️ Quick Copy-Paste Commands

### 🟢 1. Simple Hedge (Passive Market Making)
*Best for: Passive income on 5m volatility. Places dual limit orders to capture spread.*

```bash
# Default (35c fixed price, $20 size, 10m cooldown)
./trade btc --simple-hedge

# Randomized Price Range (e.g. 0.33-0.35)
./trade btc --simple-hedge --price=0.33-0.35

# Custom Setup (Larger size, Longer cooldown)
./trade btc --simple-hedge --size=50 --cooldown=15
```

### 🔴 2. The Gabagool (Dip Buying)
*Best for: Catching panic dumps. Buys when price crashes X% in Y seconds.*

```bash
# Aggressive BTC Dip Buying (15% drop, 50 shares)
./trade btc --dip=0.15 --shares=50

# Conservative ETH Dip Buying (25% drop)
./trade eth --dip=0.25
```

### 🔵 3. BTC 5m Scalper
*Best for: High-velocity scalping on 5-minute markets.*

```bash
# Run 5m Scalper
./trade btc --strategy=btc5m
```

---

## 🔧 Configuration Flags

### 🤖 Strategy: Simple Hedge
*Usage: `./trade <COIN> --simple-hedge [FLAGS]`*

| Flag | Description | Default | Example |
| :--- | :--- | :--- | :--- |
| `--price` | Fixed price OR Range | `0.35` | `--price=0.33-0.35` |
| `--size` | Trade size in USD per side | `20` | `--size=100` |
| `--cooldown` | Pause duration (mins) after failure | `10` | `--cooldown=5` |

### 📉 Strategy: Dip Arbitrage (Gabagool)
*Usage: `./trade <COIN> [FLAGS]` (Default Strategy)*

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--dip` | Price drop % to trigger buy (0.25 = 25%) | *Var* |
| `--target` | Sum Target to exit (AvgYes + AvgNo) | `0.96` |
| `--shares` | Max shares per clip | *Var* |
| `--timeout` | Max wait (sec) before Force Hedge | *Var* |
| `--min-profit` | Min Expected Profit per trade ($) | *Var* |
| `--min-price` | Minimum price to trade (avoid dust) | `0.06` |

### 🌍 System Flags
*Applies to all strategies.*

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--coin=<COIN>` | Target Asset (BTC, ETH, SOL, XRP) | `ETH` |
| `--redeem` | Redeem all winning positions and exit | `false` |
| `--dashboard` | Launch standalone PnL Dashboard | `false` |
| `--info` | Show wallet balances and exit | `false` |
| `--verbose` | Enable debug logs | `false` |

---

## 🚀 Features

### 🧠 Strategic Engines
1.  **The Gabagool (Dip Arbitrage)**
    *   **Logic**: Exploits mean-reversion in binary markets. Accumulates heavily when spreads widen (panic dumps) and exits when spreads normalize.
    *   **Best For**: High-volatility events (Election nights, Sporting upsets).

2.  **Simple Hedge (Neutral Market Making)**
    *   **Logic**: Places dormant limit orders on both sides (Yes/No) to capture spread and volatility.
    *   **Behavior**: Joins 5-minute markets, places dual orders.
    *   **Smart Features**:
        *   **Randomized Pricing**: Avoids predictability by varying limit prices.
        *   **Auto-Redeem**: Claims winnings immediately after market expiry.
        *   **Strict Cooldown**: Pauses trading if hedge fails (partial fills) to protect capital.

3.  **BTC 5m Scalper**
    *   **Logic**: Specialized high-velocity strategy for 5-minute BTC markets with tighter timing.

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
    ```

3.  **Build**
    ```bash
    npm run build
    ```

---

## ⚠️ Disclaimer
*Prediction markets are volatile. Use at your own risk. The authors accept no liability for financial losses.*
