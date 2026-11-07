import {
    createSecureClient,
    OrderSide,
    OrderType as PolymarketOrderType,
    relayerApiKey,
} from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { signerFrom } from "@polymarket/client/viem";
import { createWalletClient, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { CONFIG, requirePrivateKey } from "./config.js";

export { OrderSide as Side, PolymarketOrderType as OrderType };

export const AssetType = {
    COLLATERAL: "COLLATERAL",
    CONDITIONAL: "CONDITIONAL",
    CONDITIONAL_V2: "CONDITIONAL-V2",
} as const;

type SecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type LegacyOrderRequest = {
    tokenID?: string;
    tokenId?: string;
    assetId?: string;
    price: number | string;
    size: number | string;
    side: OrderSide;
};

type LegacyOrderOptions = {
    tickSize?: string;
    negRisk?: boolean;
    postOnly?: boolean;
};

type LegacyOrderType = (typeof PolymarketOrderType)[keyof typeof PolymarketOrderType];

/**
 * Strategy-facing adapter around Polymarket's maintained unified SDK.
 * It keeps the existing strategy interface stable while translating to the
 * SDK's current camelCase methods and response shapes.
 */
export class ClobClient {
    private approvalSetup?: Promise<unknown>;

    constructor(
        private readonly client: SecureClient,
        private readonly walletAddress: string,
    ) {}

    async getBalanceAllowance(params: { asset_type?: string; assetType?: string; token_id?: string; tokenId?: string }) {
        const tokenId = params.token_id ?? params.tokenId;
        const result = await fetchBalanceAllowance(this.client, {
            assetType: (params.assetType ?? params.asset_type ?? AssetType.COLLATERAL) as any,
            ...(tokenId ? { assetId: tokenId } : {}),
        });
        return normalizeBalanceAllowance(result);
    }

    async updateBalanceAllowance(params: { asset_type?: string; assetType?: string; token_id?: string; tokenId?: string }) {
        if (!this.approvalSetup) {
            this.approvalSetup = this.client.setupTradingApprovals().catch((error) => {
                this.approvalSetup = undefined;
                throw error;
            });
        }
        await this.approvalSetup;
        return this.getBalanceAllowance(params);
    }

    async getOpenOrders(params?: { market?: string; asset_id?: string; assetId?: string }) {
        const market = params?.market;
        const assetId = params?.assetId ?? params?.asset_id ?? (market && !market.startsWith("0x") ? market : undefined);
        const conditionId = market?.startsWith("0x") ? market : undefined;
        const paginator = this.client.listOpenOrders({
            ...(assetId ? { assetId } : {}),
            ...(conditionId ? { market: conditionId } : {}),
        } as any);
        const orders: any[] = [];
        for await (const page of paginator) {
            orders.push(...page.items.map(normalizeOrder));
        }
        return { orders };
    }

    async getTrades(params?: { market?: string; asset_id?: string; assetId?: string }) {
        const requestedAsset = params?.assetId ?? params?.asset_id ?? params?.market;
        const paginator = this.client.listTrades({ user: this.walletAddress, pageSize: 100, takerOnly: false } as any);
        const page = await paginator.firstPage();
        const trades = page.items
            .filter((trade: any) => !requestedAsset || trade.assetId === requestedAsset || trade.asset_id === requestedAsset)
            .map((trade: any) => ({
                ...trade,
                asset_id: trade.assetId ?? trade.asset_id,
                condition_id: trade.conditionId ?? trade.condition_id,
                size: trade.size,
            }));
        return { trades };
    }

    async getOrder(orderId: string) {
        return normalizeOrder(await this.client.fetchOrder({ orderId }));
    }

    async getOrderBook(assetId: string) {
        return this.client.fetchOrderBook({ assetId });
    }

    async getMidpoint(assetId: string) {
        const mid = await this.client.fetchMidpoint({ assetId });
        return { mid: mid ?? null };
    }

    async createAndPostOrder(
        request: LegacyOrderRequest,
        options: LegacyOrderOptions = {},
        orderType?: LegacyOrderType,
    ) {
        if (orderType && orderType !== PolymarketOrderType.GTC) {
            throw new Error(`Unsupported limit order type: ${orderType}. Use GTC or the SDK's market order methods.`);
        }

        const assetId = request.assetId ?? request.tokenID ?? request.tokenId;
        if (!assetId) throw new Error("Order requires an asset ID.");
        const price = Number(request.price);
        const size = Number(request.size);
        if (!Number.isFinite(price) || price <= 0 || price >= 1) {
            throw new Error(`Invalid limit price: ${request.price}`);
        }
        if (!Number.isFinite(size) || size <= 0) {
            throw new Error(`Invalid order size: ${request.size}`);
        }

        const result = await this.client.placeLimitOrder({
            assetId,
            price: request.price,
            size: request.size,
            side: request.side,
            ...(options.postOnly ? { postOnly: true } : {}),
        });
        return normalizeOrder(result);
    }

    async cancelOrder(request: { orderID?: string; orderId?: string }) {
        const orderId = request.orderId ?? request.orderID;
        if (!orderId) throw new Error("Cancellation requires an order ID.");
        return this.client.cancelOrder({ orderId });
    }

    subscribeMarket(assetIds: string[]) {
        return this.client.subscribe([{ topic: "market", assetIds }]);
    }

    async redeemPositions(conditionId: string) {
        const transaction = await this.client.redeemPositions({ conditionId });
        return transaction.wait();
    }

    async mergePositions(conditionId: string) {
        const transaction = await this.client.mergePositions({ amount: "max", conditionId });
        return transaction.wait();
    }

    get account() {
        return this.client.account;
    }
}

function normalizeOrder(order: any) {
    if (!order) return order;
    const status = typeof order.status === "string" ? order.status.toUpperCase() : order.status;
    return {
        ...order,
        success: order.ok ?? order.success,
        orderID: order.orderId ?? order.orderID ?? order.id,
        asset_id: order.assetId ?? order.asset_id,
        size: order.originalSize ?? order.size,
        original_size: order.originalSize ?? order.original_size ?? order.size,
        size_matched: order.sizeMatched ?? order.size_matched ?? "0",
        status,
    };
}

export function normalizeBalanceAllowance(value: any) {
    const allowances = value?.allowances ?? value?.allowance ?? {};
    return {
        ...value,
        balance: value?.balance == null ? value?.balance : String(value.balance),
        allowances: Object.fromEntries(Object.entries(allowances).map(([key, amount]) => [key, String(amount)])),
    };
}

export async function createClobClient(accountWallet?: string): Promise<ClobClient> {
    const privateKey = requirePrivateKey();
    const rpcUrls = CONFIG.RPC_URLS;
    if (rpcUrls.length === 0) throw new Error("Set RPC_URL or at least one backup RPC_URL_n.");

    const account = privateKeyToAccount(privateKey as Hex);
    const transports = rpcUrls.map((url) => http(url));
    const signer = createWalletClient({
        account,
        chain: polygon,
        transport: transports.length === 1 ? transports[0] : fallback(transports),
    });
    const walletAddress = accountWallet || CONFIG.POLY_PROXY_ADDRESS || account.address;
    const authorization = CONFIG.RELAYER_API_KEY && CONFIG.RELAYER_API_KEY_ADDRESS
        ? relayerApiKey({ key: CONFIG.RELAYER_API_KEY, address: CONFIG.RELAYER_API_KEY_ADDRESS })
        : undefined;

    console.log(`[ClobClient] Connecting account wallet ${walletAddress} with the Polymarket unified SDK.`);
    const client = await createSecureClient({
        wallet: walletAddress,
        signer: signerFrom(signer),
        ...(authorization ? { apiKey: authorization } : {}),
        onRateLimitUpdate: (update) => {
            console.warn("[CLOB rate limit]", update);
        },
    });

    return new ClobClient(client, walletAddress);
}
