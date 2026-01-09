
import { ethers, Contract, Wallet } from 'ethers';
import { CONFIG } from './config.js';

// ===== Contract Addresses (Polygon Mainnet) =====

export const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e
export const USDC_DECIMALS = 6;

// ===== ABIs =====

const CTF_ABI = [
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    'function balanceOf(address account, uint256 positionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const GNOSIS_SAFE_ABI = [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)'
];

// ===== Types =====

export interface TokenIds {
    yesTokenId: string;
    noTokenId: string;
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

export interface PositionBalance {
    conditionId: string;
    yesBalance: string;
    noBalance: string;
    yesPositionId: string;
    noPositionId: string;
}

// ===== CTF Client =====

export class CTFClient {
    private provider: ethers.providers.JsonRpcProvider;
    private wallet: Wallet;
    private ctfContract: Contract;
    private usdcContract: Contract;

    constructor() {
        this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        this.wallet = new Wallet(CONFIG.PRIVATE_KEY, this.provider);
        this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.wallet);
        this.usdcContract = new Contract(USDC_CONTRACT, ERC20_ABI, this.wallet);
    }

    getAddress(): string {
        return this.wallet.address;
    }

    /**
     * Check if a market is resolved and get payout info
     */
    async getMarketResolution(conditionId: string): Promise<MarketResolution> {
        const [yesNumerator, noNumerator, denominator] = await Promise.all([
            this.ctfContract.payoutNumerators(conditionId, 0),
            this.ctfContract.payoutNumerators(conditionId, 1),
            this.ctfContract.payoutDenominator(conditionId),
        ]);

        const isResolved = denominator.gt(0);
        let winningOutcome: 'YES' | 'NO' | undefined;

        if (isResolved) {
            if (yesNumerator.gt(0) && noNumerator.eq(0)) {
                winningOutcome = 'YES';
            } else if (noNumerator.gt(0) && yesNumerator.eq(0)) {
                winningOutcome = 'NO';
            }
        }

        return {
            conditionId,
            isResolved,
            winningOutcome,
            payoutNumerators: [yesNumerator.toNumber(), noNumerator.toNumber()],
            payoutDenominator: denominator.toNumber(),
        };
    }

    /**
     * Get token balances using CLOB API token IDs
     */
    async getPositionBalanceByTokenIds(
        conditionId: string,
        tokenIds: TokenIds,
        userAddress?: string
    ): Promise<PositionBalance> {
        const address = userAddress || this.wallet.address;
        const [yesBalance, noBalance] = await Promise.all([
            this.ctfContract.balanceOf(address, tokenIds.yesTokenId),
            this.ctfContract.balanceOf(address, tokenIds.noTokenId),
        ]);

        return {
            conditionId,
            yesBalance: ethers.utils.formatUnits(yesBalance, USDC_DECIMALS),
            noBalance: ethers.utils.formatUnits(noBalance, USDC_DECIMALS),
            yesPositionId: tokenIds.yesTokenId,
            noPositionId: tokenIds.noTokenId,
        };
    }

    /**
     * Redeem winning tokens using Polymarket token IDs (Polymarket CLOB)
     */
    async redeemByTokenIds(
        conditionId: string,
        tokenIds: TokenIds,
        outcome?: string,
        isProxy: boolean = false
    ): Promise<RedeemResult> {
        // Check resolution status
        const resolution = await this.getMarketResolution(conditionId);
        if (!resolution.isResolved) {
            throw new Error('Market is not resolved yet');
        }

        // Auto-detect outcome if not provided
        const winningOutcome = outcome || resolution.winningOutcome;
        if (!winningOutcome) {
            throw new Error('Could not determine winning outcome');
        }

        const targetAddress = isProxy && CONFIG.POLY_PROXY_ADDRESS ? CONFIG.POLY_PROXY_ADDRESS : this.wallet.address;

        // Get token balance using Polymarket token IDs
        const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds, targetAddress);
        const tokenBalance = winningOutcome === 'YES' ? balances.yesBalance : balances.noBalance;

        if (parseFloat(tokenBalance) === 0) {
            throw new Error(`No ${winningOutcome} tokens to redeem`);
        }

        console.log(`Redeeming ${tokenBalance} ${winningOutcome} tokens from ${targetAddress}...`);

        // indexSets: [1] for YES, [2] for NO
        const indexSets = winningOutcome === 'YES' ? [1] : [2];

        // 1.5 multiplier for gas
        const gasPrice = await this.provider.getGasPrice();
        const gasOptions = {
            gasPrice: gasPrice.mul(15).div(10)
        };

        let tx;
        if (isProxy) {
            // PROXY REDEMPTION via Gnosis Safe execTransaction
            if (!CONFIG.POLY_PROXY_ADDRESS) throw new Error("Proxy address required for proxy redemption");
            const proxyContract = new Contract(CONFIG.POLY_PROXY_ADDRESS, GNOSIS_SAFE_ABI, this.wallet);

            // Encode the inner call: redeemPositions(...)
            const innerData = this.ctfContract.interface.encodeFunctionData("redeemPositions", [
                USDC_CONTRACT,
                ethers.constants.HashZero,
                conditionId,
                indexSets
            ]);

            // Prepare execTransaction params
            const to = CTF_CONTRACT;
            const value = 0;
            const data = innerData;
            const operation = 0; // Call
            const safeTxGas = 0;
            const baseGas = 0;
            const gasToken = ethers.constants.AddressZero;
            const refundReceiver = ethers.constants.AddressZero;
            const nonce = await this.getSafeNonce(CONFIG.POLY_PROXY_ADDRESS);

            // Sign the transaction
            // Hash: keccak256(pack(folder, ...)) - Simplified: We use EIP-712 or standard safe hash
            // Actually, for single owner safe (or threshold 1), we can sign the hash.
            // Polymarket proxies are usually 1/1 ownership setups controlled by the EOA.
            // We need to calculate the SafeTxHash and sign it.

            const signature = await this.signSafeTransaction(
                CONFIG.POLY_PROXY_ADDRESS,
                to,
                value,
                data,
                operation,
                safeTxGas,
                baseGas,
                gasPrice.toString(),
                gasToken,
                refundReceiver,
                nonce
            );

            console.log(`Sending Proxy Transaction...`);
            tx = await proxyContract.execTransaction(
                to,
                value,
                data,
                operation,
                safeTxGas,
                baseGas,
                0, // gasPrice in safe logic (usually 0 if relayer pays or self-pay)
                gasToken,
                refundReceiver,
                signature,
                gasOptions
            );

        } else {
            // STANDARD EOA REDEMPTION
            tx = await this.ctfContract.redeemPositions(
                USDC_CONTRACT,
                ethers.constants.HashZero,
                conditionId,
                indexSets,
                gasOptions
            );
        }

        console.log(`Tx sent: ${tx.hash}`);
        const receipt = await tx.wait();

        return {
            success: true,
            txHash: receipt.transactionHash,
            outcome: winningOutcome,
            tokensRedeemed: tokenBalance,
            usdcReceived: tokenBalance, // 1:1 for winning outcome
        };
    }

    /**
     * Merge positions to recover collateral (if holding both YES and NO)
     */
    async mergeByTokenIds(
        conditionId: string,
        tokenIds: TokenIds,
        amount: string,
        isProxy: boolean = false
    ): Promise<RedeemResult> {
        console.log(`Merging ${amount} sets...`);

        // Partition: [1, 2] for Yes + No
        const partition = [1, 2];
        const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

        // 1.5 multiplier for gas
        const gasPrice = await this.provider.getGasPrice();
        const gasOptions = {
            gasPrice: gasPrice.mul(15).div(10)
        };

        const targetAddress = isProxy && CONFIG.POLY_PROXY_ADDRESS ? CONFIG.POLY_PROXY_ADDRESS : this.wallet.address;

        let tx;
        if (isProxy) {
            // PROXY MERGE
            if (!CONFIG.POLY_PROXY_ADDRESS) throw new Error("Proxy address required for proxy merge");
            const proxyContract = new Contract(CONFIG.POLY_PROXY_ADDRESS, GNOSIS_SAFE_ABI, this.wallet);

            const innerData = this.ctfContract.interface.encodeFunctionData("mergePositions", [
                USDC_CONTRACT,
                ethers.constants.HashZero,
                conditionId,
                partition,
                amountWei
            ]);

            const nonce = await this.getSafeNonce(CONFIG.POLY_PROXY_ADDRESS);
            const signature = await this.signSafeTransaction(
                CONFIG.POLY_PROXY_ADDRESS,
                CTF_CONTRACT,
                0,
                innerData,
                0,
                0,
                0,
                gasPrice.toString(),
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                nonce
            );

            console.log(`Sending Proxy Merge Transaction...`);
            tx = await proxyContract.execTransaction(
                CTF_CONTRACT,
                0,
                innerData,
                0,
                0,
                0,
                0,
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                signature,
                gasOptions
            );

        } else {
            // EOA MERGE
            tx = await this.ctfContract.mergePositions(
                USDC_CONTRACT,
                ethers.constants.HashZero,
                conditionId,
                partition,
                amountWei,
                gasOptions
            );
        }

        console.log(`Merge Tx sent: ${tx.hash}`);
        const receipt = await tx.wait();

        return {
            success: true,
            txHash: receipt.transactionHash,
            outcome: "MERGE",
            tokensRedeemed: amount,
            usdcReceived: amount,
        };
    }

    // --- Transaction Builders for Batching ---

    getMergeTransaction(conditionId: string, amount: string): { to: string; data: string; value: string } {
        const partition = [1, 2];
        const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

        const data = this.ctfContract.interface.encodeFunctionData("mergePositions", [
            USDC_CONTRACT,
            ethers.constants.HashZero,
            conditionId,
            partition,
            amountWei
        ]);

        return {
            to: CTF_CONTRACT,
            data,
            value: "0"
        };
    }

    getRedeemTransaction(conditionId: string): { to: string; data: string; value: string } {
        // Redeem both YES (1) and NO (2) slots to ensure full cleanup (winners paid, losers burned)
        const indexSets = [1, 2];

        const data = this.ctfContract.interface.encodeFunctionData("redeemPositions", [
            USDC_CONTRACT,
            ethers.constants.HashZero,
            conditionId,
            indexSets
        ]);

        return {
            to: CTF_CONTRACT,
            data,
            value: "0"
        };
    }

    // --- Helper for Safe Signing ---

    private async getSafeNonce(safeAddress: string): Promise<number> {
        const safe = new Contract(safeAddress, ['function nonce() view returns (uint256)'], this.provider);
        return (await safe.nonce()).toNumber();
    }

    private async signSafeTransaction(
        safeAddress: string,
        to: string,
        value: number,
        data: string,
        operation: number,
        safeTxGas: number,
        baseGas: number,
        gasPrice: string,
        gasToken: string,
        refundReceiver: string,
        nonce: number
    ): Promise<string> {

        // EIP-712 Domain
        const domain = {
            verifyingContract: safeAddress,
            chainId: CONFIG.CHAIN_ID || 137
        };

        const EIP712_SAFE_TX_TYPE = {
            SafeTx: [
                { type: "address", name: "to" },
                { type: "uint256", name: "value" },
                { type: "bytes", name: "data" },
                { type: "uint8", name: "operation" },
                { type: "uint256", name: "safeTxGas" },
                { type: "uint256", name: "baseGas" },
                { type: "uint256", name: "gasPrice" },
                { type: "address", name: "gasToken" },
                { type: "address", name: "refundReceiver" },
                { type: "uint256", name: "nonce" }
            ]
        };

        const safeTx = {
            to,
            value,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice: 0, // usually 0 for self-signed immediate exec
            gasToken,
            refundReceiver,
            nonce
        };

        // Sign using Ethers _signTypedData (v5) or signTypedData (v6)
        // Check ethers version in package.json (usually v5.7.2)
        // Wallet supports _signTypedData
        const signature = await (this.wallet as any)._signTypedData(domain, EIP712_SAFE_TX_TYPE, safeTx);
        return signature;
    }
}
