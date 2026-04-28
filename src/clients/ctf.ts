import { ethers, Contract, Wallet } from 'ethers';
import { CONFIG } from './config.js';


// ===== Contract Addresses (Polygon Mainnet) =====

export const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const USDC_CONTRACT = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // pUSD
export const MULTISEND_CONTRACT = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D'; // Proxy MultiSend mapping
export const USDC_DECIMALS = 6;

// ===== ABIs =====

const CTF_ABI = [
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    'function balanceOf(address account, uint256 positionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const GNOSIS_SAFE_ABI = [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
    'function nonce() view returns (uint256)'
];

// ===== Types =====

export interface TokenIds {
    yesTokenId?: string;
    noTokenId?: string;
}

export interface RedeemResult {
    success: boolean;
    txHash: string;
    outcome: string;
    tokensRedeemed: string;
    usdcReceived: string;
}

export interface MarketResolution {
    conditionId: string;
    isResolved: boolean;
    winningOutcome?: string;
    payoutNumerators: [number, number];
    payoutDenominator: number;
}

export interface ConditionBalance {
    conditionId: string;
    balances: string[]; // Ordered by outcome index
    tokenIds: string[]; // Ordered by outcome index
}

// ===== CTF Client =====

/**
 * CTFClient
 * Handles Polymarket Conditional Token (CTF) operations: Split, Merge, Redeem.
 * Supports both EOA and Gnosis Safe Proxy (Gasless Relayer V2) execution.
 */
export class CTFClient {
    private provider: ethers.providers.JsonRpcProvider;
    private wallet: Wallet;
    private ctfContract: Contract;
    private usdcContract: Contract;

    constructor() {
        // Explicitly set chainID 137 (Polygon) to avoid auto-detection failure in strict environments
        this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URLS[0] || CONFIG.RPC_URL, CONFIG.CHAIN_ID || 137);
        this.wallet = new Wallet(CONFIG.PRIVATE_KEY, this.provider);
        this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.wallet);
        this.usdcContract = new Contract(USDC_CONTRACT, ERC20_ABI, this.wallet);

    }

    getAddress(): string {
        return this.wallet.address;
    }

    /**
     * Executes a batch of transactions using the official Builder Relayer SDK.
     * This handles MultiSend bundling and signing automatically.
     */
    async executeBuilderBatch(txns: { to: string; data: string; value: string }[]): Promise<boolean> {
        console.log(`[BuilderBatch] Forwarding ${txns.length} transactions to executeV2Relayer...`);
        return this.executeV2Relayer(txns);
    }

    async getMarketResolution(conditionId: string): Promise<MarketResolution> {
        let denominator = ethers.BigNumber.from(0);
        const payouts: any[] = [];
        
        try {
            denominator = await this.ctfContract.payoutDenominator(conditionId);
            const isResolved = denominator.gt(0);
            
            if (isResolved) {
                // Check up to 10 outcomes sequentially to avoid revert-on-parallel
                for (let i = 0; i < 10; i++) {
                    try {
                        const p = await this.ctfContract.payoutNumerators(conditionId, i);
                        payouts.push(p);
                    } catch (e) {
                        break; // Index out of bounds or other failure
                    }
                }
            }
        } catch (e: any) {
            console.error(`[CTFClient] Failed to check resolution: ${e.message}`);
        }

        const isResolved = denominator.gt(0);
        let winningOutcome: string | undefined;

        if (isResolved && payouts.length > 0) {
            const winIdx = payouts.findIndex(p => p.gt(0));
            if (winIdx !== -1) {
                winningOutcome = `OUTCOME_${winIdx}`;
                if (winIdx === 0) winningOutcome = 'YES';
                else if (winIdx === 1) winningOutcome = 'NO';
            }
        }

        return {
            conditionId,
            isResolved,
            winningOutcome,
            payoutNumerators: payouts.slice(0, 2).map(p => (p as any).toNumber()) as [number, number],
            payoutDenominator: (denominator as any).toNumber(),
        };
    }

    /**
     * Helper to generate index sets for up to N outcomes.
     * indexSets[i] = 1 << i.
     * Standard Polymarket binary markets use [1, 2].
     */
    getIndexSets(count: number = 2): number[] {
        const sets: number[] = [];
        for (let i = 0; i < count; i++) {
            sets.push(1 << i);
        }
        return sets;
    }



    /**
     * Encodes multiple standard transactions into a single Gnosis Safe MultiSend byte payload.
     * Compatible with MultiSend deployed at MULTISEND_CONTRACT.
     */
    private encodeMultiSend(txs: { to: string; data: string; value: string }[]): string {
        let encodedTxs = "0x";
        for (const tx of txs) {
            const operation = 0; // 0 = Call
            const to = tx.to.toLowerCase().slice(2);
            const value = ethers.utils.hexZeroPad(ethers.BigNumber.from(tx.value || 0).toHexString(), 32).slice(2);
            
            const data = tx.data.startsWith('0x') ? tx.data.slice(2) : tx.data;
            const dataLength = ethers.utils.hexZeroPad(ethers.utils.hexlify(data.length / 2), 32).slice(2);
            
            encodedTxs += ethers.utils.hexZeroPad(ethers.utils.hexlify(operation), 1).slice(2) + to + value + dataLength + data;
        }

        const multiSendAbi = ["function multiSend(bytes transactions)"];
        const iface = new ethers.utils.Interface(multiSendAbi);
        return iface.encodeFunctionData("multiSend", [encodedTxs]);
    }

    /**
     * Submit transactions gaslessly via the Relayer V2
     * Combines >1 transactions natively using Gnosis MultiSend struct.
     */
    async executeV2Relayer(txs: { to: string; data: string; value: string; }[]): Promise<boolean> {
        const credsList = CONFIG.RELAYER_CREDS_LIST || [];
        if (credsList.length === 0 || !CONFIG.POLY_PROXY_ADDRESS) {
            console.warn("⚠️ Relayer V2 Config Incomplete. Falling back to EOA direct.");
            return false; 
        }

        const proxyWallet = CONFIG.POLY_PROXY_ADDRESS;
        
        // BATCHING LOGIC
        let finalTxs = txs;
        let isBatch = false;
        
        if (txs.length > 1) {
            const multiSendData = this.encodeMultiSend(txs);
            finalTxs = [{
                to: MULTISEND_CONTRACT,
                data: multiSendData,
                value: "0"
            }];
            isBatch = true;
            console.log(`[RelayerV2] Bundled ${txs.length} transactions into a MultiSend Execute Call.`);
        }

        let totalSuccess = true;

        for (let i = 0; i < finalTxs.length; i++) {
            const tx = finalTxs[i];
            const nonceResult = await this.getRelayerNonce(this.wallet.address);
            const nonce = parseInt(nonceResult);
            const value = tx.value || "0";
            
            // 1 for DelegateCall if multiSend batch, 0 for Call if single tx 
            const operation = isBatch ? 1 : 0;
            
            // AUDIT FIX: Harden safe verification with official domain
            const signature = await this.signSafeTransaction(
                proxyWallet,
                tx.to,
                value,
                tx.data,
                operation, // Updated
                0, 0, "0",
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                nonce
            );

            const payload = {
                from: this.wallet.address,
                to: tx.to,
                proxyWallet: proxyWallet,
                data: tx.data,
                nonce: nonce.toString(),
                signature: signature,
                signatureParams: {
                    gasPrice: "0",
                    operation: operation.toString(), // Updated to match
                    safeTxnGas: "0",
                    baseGas: "0",
                    gasToken: ethers.constants.AddressZero,
                    refundReceiver: ethers.constants.AddressZero
                },
                type: "SAFE",
                metadata: ""
            };

            let txSuccess = false;

            console.log(`[RelayerV2] Submitting gasless tx (${i+1}/${finalTxs.length}) for ${proxyWallet}...`);
            
            for (let j = 0; j < credsList.length; j++) {
                const currentCreds = credsList[j];

                try {
                    const response = await fetch("https://relayer-v2.polymarket.com/submit", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "RELAYER_API_KEY": currentCreds.key,
                            "RELAYER_API_KEY_ADDRESS": currentCreds.address
                        },
                        body: JSON.stringify(payload)
                    });

                    if (response.ok) {
                        const resData = await response.json() as any;
                        console.log(`✅ Relayer V2 Registered using API Key Address ${currentCreds.address}: ID ${resData.transactionID || resData.id}`);
                        txSuccess = true;
                        break; 
                    } else {
                        const text = await response.text();
                        console.warn(`⚠️ Relayer API Key Address ${currentCreds.address} Error (${response.status}): ${text}`);

                        if (response.status === 429 || text.includes("quota exceeded")) {
                            console.warn(`⚠️ Rate limit exhausted for API Key address: ${currentCreds.address}. Rotating...`);
                            continue; 
                        } else {
                            console.error(`❌ Non-rate-limit failure. Stopping.`);
                            txSuccess = false;
                            break;
                        }
                    }
                } catch (e: any) {
                    console.error(`❌ Fetch failure for Key Address ${currentCreds.address}: ${e.message}`);
                }
            }

            if (!txSuccess) {
                totalSuccess = false;
                break;
            }
            
            if (i < finalTxs.length - 1) await new Promise(r => setTimeout(r, 2000));
        }
        return totalSuccess;
    }

    async getRelayerNonce(signerAddress: string): Promise<string> {
        const res = await fetch(`https://relayer-v2.polymarket.com/nonce?address=${signerAddress}&type=SAFE`);
        if (!res.ok) throw new Error(`Relayer nonce fetch failed: ${res.statusText}`);
        const data = await res.json() as any;
        return data.nonce;
    }

    private async signSafeTransaction(
        safeAddress: string,
        to: string,
        value: string | number,
        data: string,
        operation: number,
        safeTxGas: number,
        baseGas: number,
        gasPrice: string,
        gasToken: string,
        refundReceiver: string,
        nonce: number
    ): Promise<string> {

        // AUDIT FIX: Use strict Gnosis Safe domain for 100% compatibility
        const domain = {
            chainId: CONFIG.CHAIN_ID || 137,
            verifyingContract: safeAddress
        };

        const types = {
            SafeTx: [
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "data", type: "bytes" },
                { name: "operation", type: "uint8" },
                { name: "safeTxGas", type: "uint256" },
                { name: "baseGas", type: "uint256" },
                { name: "gasPrice", type: "uint256" },
                { name: "gasToken", type: "address" },
                { name: "refundReceiver", type: "address" },
                { name: "nonce", type: "uint256" }
            ]
        };

        const values = {
            to,
            value: ethers.BigNumber.from(value).toString(),
            data,
            operation,
            safeTxGas: safeTxGas.toString(),
            baseGas: baseGas.toString(),
            gasPrice,
            gasToken,
            refundReceiver,
            nonce
        };

        // Polymarket Relayer strictly expects standard EOA eth_sign instead of EIP-712 strings
        // So we manually struct-hash and then append the correct v offset based on standard spec.
        const structHash = ethers.utils._TypedDataEncoder.hash(domain, types, values);
        const sigEthers = await this.wallet.signMessage(ethers.utils.arrayify(structHash));
        
        let sigV = parseInt(sigEthers.slice(-2), 16);
        if (sigV === 27 || sigV === 28) { sigV += 4; }
        
        return sigEthers.slice(0, -2) + sigV.toString(16);
    }

    // --- High-Level Commands ---

    async mergePositionsDirect(conditionId: string, amount: string, isProxy: boolean = false): Promise<RedeemResult> {
        const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
        const data = this.ctfContract.interface.encodeFunctionData("mergePositions", [USDC_CONTRACT, ethers.constants.HashZero, conditionId, [1, 2], amountWei]);

        let txHash = "";
        if (isProxy) {
            const success = await this.executeV2Relayer([{ to: CTF_CONTRACT, data, value: "0" }]);
            if (!success) throw new Error("Relayer V2 merge failed");
            txHash = "submitted_via_relayer";
        } else {
            const gasPrice = await this.provider.getGasPrice();
            const tx = await this.ctfContract.mergePositions(USDC_CONTRACT, ethers.constants.HashZero, conditionId, [1, 2], amountWei, { gasPrice: gasPrice.mul(15).div(10) });
            const receipt = await tx.wait();
            txHash = receipt.transactionHash;
        }

        return { success: true, txHash, outcome: "MERGE", tokensRedeemed: amount, usdcReceived: amount };
    }

    async redeemPositionsDirect(conditionId: string, outcome?: string, isProxy: boolean = false): Promise<RedeemResult> {
        const res = await this.getMarketResolution(conditionId);
        if (!res.isResolved) throw new Error('Market not resolved');

        // Standard Polymarket binary markets use indexSets [1, 2].
        const indexSets = [1, 2];
        const data = this.ctfContract.interface.encodeFunctionData("redeemPositions", [USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets]);

        let txHash = "";
        if (isProxy) {
            const success = await this.executeV2Relayer([{ to: CTF_CONTRACT, data, value: "0" }]);
            if (!success) throw new Error("Relayer V2 submission failed");
            txHash = "submitted_via_relayer";
        } else {
            const gasPrice = await this.provider.getGasPrice();
            const tx = await this.ctfContract.redeemPositions(USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets, { gasPrice: gasPrice.mul(15).div(10) });
            const receipt = await tx.wait();
            txHash = receipt.transactionHash;
        }

        return { success: true, txHash, outcome: outcome || res.winningOutcome || "UNKNOWN", tokensRedeemed: "0", usdcReceived: "0" };
    }

    /**
     * Get a transaction object for merging a full set of outcome tokens back into USDC.e.
     */
    getMergeTransaction(conditionId: string, outcomeCount: number, amount: string): { to: string; data: string; value: string } {
        const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
        const indexSets = this.getIndexSets(outcomeCount);
        const data = this.ctfContract.interface.encodeFunctionData("mergePositions", [USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets, amountWei]);
        return { to: CTF_CONTRACT, data, value: "0" };
    }

    /**
     * Get a transaction object for redeeming winning tokens for a condition.
     */
    getRedeemTransaction(conditionId: string, outcomeCount: number): { to: string; data: string; value: string } {
        const indexSets = this.getIndexSets(outcomeCount);
        const data = this.ctfContract.interface.encodeFunctionData("redeemPositions", [USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets]);
        return { to: CTF_CONTRACT, data, value: "0" };
    }

    /**
     * Fetch balances for multiple token IDs (positions) for a specific user.
     */
    async getBalancesByTokenIds(conditionId: string, tokenIds: string[], userAddress: string): Promise<ConditionBalance> {
        const balances = await Promise.all(
            tokenIds.map(id => id ? this.ctfContract.balanceOf(userAddress, id) : ethers.BigNumber.from(0))
        );

        return {
            conditionId,
            balances: balances.map(b => ethers.utils.formatUnits(b, USDC_DECIMALS)),
            tokenIds
        };
    }

    /**
     * Merge all outcomes for a condition.
     */
    async mergeByTokenIds(conditionId: string, tokenIds: string[], amount: string, isProxy: boolean = false): Promise<RedeemResult> {
        const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
        const indexSets = this.getIndexSets(tokenIds.length);
        const data = this.ctfContract.interface.encodeFunctionData("mergePositions", [USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets, amountWei]);

        let txHash = "";
        if (isProxy) {
            const success = await this.executeV2Relayer([{ to: CTF_CONTRACT, data, value: "0" }]);
            if (!success) throw new Error("Relayer V2 merge failed");
            txHash = "submitted_via_relayer";
        } else {
            const gasPrice = await this.provider.getGasPrice();
            const tx = await this.ctfContract.mergePositions(USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets, amountWei, { gasPrice: gasPrice.mul(15).div(10) });
            const receipt = await tx.wait();
            txHash = receipt.transactionHash;
        }

        return { success: true, txHash, outcome: "MERGE", tokensRedeemed: amount, usdcReceived: amount };
    }

    /**
     * Redeem all outcomes for a condition.
     */
    async redeemByTokenIds(conditionId: string, tokenIds: string[], isProxy: boolean = false): Promise<RedeemResult> {
        const res = await this.getMarketResolution(conditionId);
        if (!res.isResolved) throw new Error('Market not resolved');

        const indexSets = this.getIndexSets(tokenIds.length);
        const data = this.ctfContract.interface.encodeFunctionData("redeemPositions", [USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets]);

        let txHash = "";
        if (isProxy) {
            const success = await this.executeV2Relayer([{ to: CTF_CONTRACT, data, value: "0" }]);
            if (!success) throw new Error("Relayer V2 submission failed");
            txHash = "submitted_via_relayer";
        } else {
            const gasPrice = await this.provider.getGasPrice();
            const tx = await this.ctfContract.redeemPositions(USDC_CONTRACT, ethers.constants.HashZero, conditionId, indexSets, { gasPrice: gasPrice.mul(15).div(10) });
            const receipt = await tx.wait();
            txHash = receipt.transactionHash;
        }

        return { success: true, txHash, outcome: res.winningOutcome || "UNKNOWN", tokensRedeemed: "0", usdcReceived: "0" };
    }

    /**
     * Scan recent blockchain history for TransferSingle events to the user's address.
     * This is the source of truth for all positions ever held.
     */
    async getHistoricalTokenIds(userAddress: string, blockCount: number = 20000, externalProvider?: ethers.providers.Provider): Promise<string[]> {
        const provider = externalProvider || this.provider;
        const currentBlock = await provider.getBlockNumber();
        const startBlock = Math.max(0, currentBlock - blockCount);

        console.log(`[CTFClient] Scanning blocks ${startBlock} to ${currentBlock} on provider ${externalProvider ? 'CUSTOM' : 'DEFAULT'}...`);
        
        const filter = this.ctfContract.filters.TransferSingle(null, null, userAddress);
        const logs = await this.ctfContract.connect(provider).queryFilter(filter, startBlock, currentBlock);
        
        // Extract unique IDs
        const ids = [...new Set(logs.map(l => (l as any).args.id.toString()))];
        console.log(`[CTFClient] Found ${ids.length} unique historical token IDs.`);
        return ids;
    }
}
