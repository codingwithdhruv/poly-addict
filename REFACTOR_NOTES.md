# Refactoring Notes: From Scripts to Bot Architecture

## 1. Initial Assessment: What was wrong?

When I first looked at the repository, I saw a collection of loose scripts (`relayClient.ts`, `clobClient.ts`, `index.ts`, `markets.ts`). 

**Key Issues Identified:**
1.  **Fragmented Logic**: There was no central "brain". You had valid code for connecting to the Relayer and valid code for connecting to the CLOB, but they were isolated. A trading bot needs both simultaneously (CLOB to read/execute trades, Relayer for on-chain management if needed, though often CLOB is enough for pure trading, Relayer is good for managing positions/funds gaslessly).
2.  **Hardcoded Configuration**: Configuration was scattered. `clobClient.ts` was importing `CONFIG` but also referencing `process.env` directly in some places. `relayClient.ts` was doing its own `process.env` reading. This makes it hard to manage execution environments.
3.  **No Strategy Interface**: The "logic" was just "run this script". A proper bot needs a `Strategy` pattern where you can plug in different algorithms (e.g., "Market Maker", "Dip Buyer", "Arb") without rewriting the connection code.
4.  **Incomplete Setup**: `clobClient.ts` had a `funderAddress` variable that was undefined in the scope, which would have caused a compile-time or runtime error.
5.  **Global Execution**: Files like `relayClient.ts` were executing code at the top level (lines 7-32 runs immediately on import). This is bad (side effects on import) and makes it impossible to test or reuse that client in another part of the system without triggering a connection.

## 2. The Thought Process: How to Fix It?

My goal was to "Restructure and Connect" as you requested.

**Step 1: Centralize Configuration**
I moved all environment variables reading to `src/config.ts`. Now, if a key is missing, the bot crashes immediately with a helpful error message ("KEY is missing"), rather than failing obscurely deep in a client execution.

**Step 2: Modularize Clients**
I took the code from `relayClient.ts` and `clobClient.ts` and wrapped them in **Factory Functions** (`createRelayClient`, `createClobClient`). 
- *Why?* This prevents side effects. Importing the file doesn't start a connection. You have to explicitly call the function.
- *Fixes*: I added the missing `funderAddress` logic to the CLOB client.

**Step 3: Define a Strategy Pattern**
I created an interface `Strategy` (in `src/strategies/types.ts`). 
- *Why?* This forces any new strategy you write to have a standard structure: `init`, `run`, `cleanup`. 
- *Benefit*: You can now write a `BollingerBandsStrategy` or `MeanReversionStrategy` and just plug it into the `Bot` without changing the bot's core code.

**Step 4: The "Bot" Class**
I created `src/bot.ts`. This is the conductor. It:
1.  Loads the config.
2.  Initializes the clients (handling the async nature of Key Derivation for the CLOB).
3.  Passes these initialized clients to the Strategy.
4.  Runs the strategy.
5.  Handles shutdown (Ctrl+C) gracefully to clean up intervals/connections.

## 3. The New Flow

1.  **Entry**: `src/index.ts` is the entry point.
2.  **Setup**: It creates a `SimpleStrategy` and passes it to a `Bot` instance.
3.  **Execution**: `Bot.start()` kicks off the factory functions to build clients.
4.  **Loop**: The `SimpleStrategy.run()` method starts a loop (polling every 10s in the example).

## 4. Next Steps for You

1.  **Add your Logic**: Open `src/strategies/simple.ts` and replace the `console.log` with real logic using `this.clobClient.getMarkets()` or `this.clobClient.createOrder()`.
2.  **Create New Strategies**: Copy `simple.ts` to `aggressive.ts`, change the class name, and implement a new algorithm. Swap it in `src/index.ts`.
3.  **Testing**: Build a `testStrategy.ts` that mocks the clients if you want to test logic without spending money.
