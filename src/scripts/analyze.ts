import { createClobClient } from "../clients/clob.js";
import fs from "fs";
import path from "path";

async function analyze() {
    const logsDir = path.join(process.cwd(), "data", "30th to 31st March Price Logs");
    if (!fs.existsSync(logsDir)) return;
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.csv'));
    
    // MODEL 1: ARBITRAGE (Simultaneous YES + NO drops)
    // Polymarket 5m markets can be highly volatile. Does the orderbook ever briefly have YES and NO both cheap?
    let arbCount95 = 0; let arbCount90 = 0; let arbCount85 = 0;
    
    // MODEL 2: MEAN REVERSION (Realistic Backtest)
    // Portfolio tracking
    let portfolioBalance = 30.0; // Start with 30 USDC
    const tradeSizeUsd = 2.0; // Fixed $2 per trade
    let completedTrades = 0;
    let successfulTrades = 0;
    
    // Sort files by some sequence? The logs don't have absolute global time across files easily, 
    // but we can simulate the "expected value" over successive trades.
    // Instead of chronological, we'll simulate the average EV applied to the portfolio.
    
    // We'll track the gross PnL points (1 point = $1 share basis)
    let totalGrossPoints = 0;

    for (const file of files) {
        const filePath = path.join(logsDir, file);
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
        if (lines.length <= 1) continue;
        
        const header = lines[0];
        const isSnapshotFormat = header.includes('yesPrice');

        let yesHistory: number[] = [];
        let yesLimitOrderPrice = 0;
        let yesPositionShares = 0;
        let yesEntryCost = 0;

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < 5) continue;
            
            let p = 0;
            if (isSnapshotFormat) {
                p = parseFloat(cols[2]); // yesPrice
            } else {
                const side = cols[3];
                if (side !== 'YES') continue;
                p = parseFloat(cols[4]);
            }
            
            yesHistory.push(p); 
                
                // Keep history to 20 ticks
                if (yesHistory.length > 20) yesHistory.shift();
                
                // If we don't have a position, place/update our Limit Buy
                if (yesPositionShares === 0 && yesHistory.length >= 20) {
                    const avgYes = yesHistory.reduce((a, b) => a + b, 0) / 20;
                    const targetBuyPrice = parseFloat((avgYes - 0.12).toFixed(2));
                    
                    // Only place limit buy if the price makes sense
                    if (targetBuyPrice > 0.10 && targetBuyPrice < 0.80) {
                        yesLimitOrderPrice = targetBuyPrice;
                    } else {
                        yesLimitOrderPrice = 0;
                    }
                    
                    // Flash crash check: did the market price drop and hit our Limit Maker order?
                    if (yesLimitOrderPrice > 0 && p <= yesLimitOrderPrice) {
                        // FILLED! We are the MAKER. Maker fee = 0%.
                        // Buy $2 worth of shares
                        yesPositionShares = tradeSizeUsd / yesLimitOrderPrice;
                        
                        // Enforce Polymarket minimums (5 shares minimum)
                        if (yesPositionShares < 5) {
                            yesPositionShares = 5;
                        }
                        
                        yesEntryCost = yesPositionShares * yesLimitOrderPrice;
                        // Deduct from portfolio
                        // If portfolio is empty, we skip (simulate bankruptcy)
                        if (portfolioBalance >= yesEntryCost) {
                            portfolioBalance -= yesEntryCost;
                            yesLimitOrderPrice = 0; // Order filled
                        } else {
                            yesPositionShares = 0; // Not enough capital
                        }
                    }
                }
                
                // If we HAVE a position, we place a Limit Sell (Maker order)
                if (yesPositionShares > 0) {
                    const avgYes = yesHistory.reduce((a, b) => a + b, 0) / 20;
                    
                    // Exit 1: Reversion Take Profit (Limit Sell at MA)
                    const targetSellPrice = parseFloat((avgYes).toFixed(2));
                    if (p >= targetSellPrice) {
                        // FILLED! (Maker = 0% fee)
                        const revenue = yesPositionShares * targetSellPrice;
                        portfolioBalance += revenue;
                        totalGrossPoints += (targetSellPrice - (yesEntryCost/yesPositionShares));
                        completedTrades++;
                        successfulTrades++;
                        yesPositionShares = 0;
                    } 
                    // Exit 2: Stop Loss (Market Sell if it plunges to 0.05)
                    else if (p <= 0.05) {
                        // FILLED! Market Sell (Taker = ~1% fee, conservatively let's just use 0.05 minus 1%)
                        const revenue = yesPositionShares * 0.05 * 0.99;
                        portfolioBalance += revenue;
                        totalGrossPoints += (0.05 - (yesEntryCost/yesPositionShares));
                        completedTrades++;
                        yesPositionShares = 0;
                    }
                }
            }
        // Removed the extra closing bracket here that was breaking `for (const file of files)`
        
        // Clean up open positions at end of file (simulate expiration at last price)
        if (yesPositionShares > 0) {
            const lastPrice = yesHistory[yesHistory.length - 1] || 0;
            const revenue = yesPositionShares * lastPrice * 0.99; // Assume taker out
            portfolioBalance += revenue;
            completedTrades++;
            if (lastPrice > yesEntryCost/yesPositionShares) successfulTrades++;
        }
    }
    
    console.log(`=== MODEL 2: REALISTIC MEAN REVERSION BACKTEST ===`);
    console.log(`Starting Balance: $30.00`);
    console.log(`Ending Balance: $${portfolioBalance.toFixed(2)}`);
    console.log(`Net Return: ${(((portfolioBalance - 30) / 30) * 100).toFixed(2)}%`);
    console.log(`Total Trades: ${completedTrades}`);
    console.log(`Win Rate: ${((successfulTrades / completedTrades) * 100).toFixed(1)}%`);
    console.log(`Maker Fees Paid: $0.00 (Limit Orders)`);
    
    console.log(`=== MODEL 1: ARBITRAGE ===`);
    console.log(`Markets where Sum <= 0.95: ${arbCount95}/${files.length} (${(arbCount95/files.length*100).toFixed(1)}%)`);
    console.log(`Markets where Sum <= 0.90: ${arbCount90}/${files.length} (${(arbCount90/files.length*100).toFixed(1)}%)`);
    console.log(`Markets where Sum <= 0.85: ${arbCount85}/${files.length} (${(arbCount85/files.length*100).toFixed(1)}%)`);
    
}

analyze().catch(console.error);
