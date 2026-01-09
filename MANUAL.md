# 🦍 Smart Ape Dip Arbitrage Bot - User Manual

Welcome to the **Poly-TS** trading bot! This bot implements the "Smart Ape" strategy to snipe short-term dips in Polymarket's 15-minute crypto markets.

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18 or newer
- **Polymarket Account**: You need a Proxy Wallet address and a Private Key (or External Wallet EOA key).

### 2. Installation
Open your terminal in this folder and run:
```bash
npm install
```

### 3. Setup Environment
Create a `.env` file in the root directory (if you haven't already) and add your private key:
```env
PRIVATE_KEY=0x...your_private_key_here...
```

### 4. Running the Bot
We have included a shortcut script `trade` to make running the bot easy. The bot uses **optimized presets** for each coin by default.

**Syntax:**
```bash
./trade <coin> [flags]
```

**Examples:**
```bash
# Trade ETH with optimized defaults
./trade eth

# Trade BTC
./trade btc 

# Trade XRP with custom shares
./trade xrp --shares=50
```

---

## ⚙️ Configuration & Presets

The bot automatically applies these settings based on the coin you select. You can override any of them with flags.

| Parameter | Flag | BTC Default | ETH Default | XRP Default | Description |
|-----------|------|-------------|-------------|-------------|-------------|
| **Dip Threshold** | `--dip` | `0.35` (35%) | `0.40` (40%) | `0.50` (50%) | Drop required in 3s to buy Leg 1. |
| **Sum Target** | `--target` | `0.96` | `0.95` | `0.94` | Max cost (Leg1+Leg2) to trigger Hedge. |
| **Shares** | `--shares` | `20` | `15` | `5` | Position size (contracts). |
| **Timeout** | `--timeout` | `90s` | `75s` | `45s` | Stop loss / timeout duration. |
| **Sliding Window** | `--window` | `3000` (ms) | `3000` (ms) | `3000` (ms) | Time window for detecting the dip. |
| **Entry Window** | `--entry-window` | `14` (min) | `14` (min) | `14` (min) | Only enter new trades in first N mins. |
| **Verbose** | `--verbose` | `false` | `false` | `false` | Show live price stream. |

---

## 🧠 The Strategy Logic
1.  **Scanning**: Finds active 15m market.
2.  **Entry Window**: Trades are allowed for the first **14 minutes** (virtually the entire 15m duration). You can restrict this to e.g., 2 minutes using `--entry-window=2`.
3.  **Leg 1 (Dip)**: Buys if price drops > Dip Threshold in 3s.
4.  **Leg 2 (Hedge)**: Buys opposite side if Total Cost < Sum Target.
5.  **Auto-Rotation**: Automatically switches to next market when current one ends.

---

## ⚠️ Notes
-   **Funds**: Ensure your Proxy Wallet (Polygon) has enough USDC.e.
-   **Prices**: 15-minute markets are volatile!
-   **Logs**: `[STATUS]` messages appear every 5 seconds.
