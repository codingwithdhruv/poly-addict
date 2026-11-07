import dotenv from "dotenv";
import { createPublicClient, fallback, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

dotenv.config();

function getRpcUrls(): string[] {
    const urls: string[] = [];
    const add = (value?: string) => {
        const url = value?.trim();
        if (url && !urls.includes(url)) urls.push(url);
    };

    add(process.env.RPC_URL);
    for (let i = 1; i <= 5; i++) {
        add(process.env[`RPC_URL_${i}`]);
    }
    return urls;
}

/** Environment values are read at startup; secret validation happens only in trading flows. */
export const CONFIG = {
    RPC_URLS: getRpcUrls(),
    PRIVATE_KEY: process.env.PRIVATE_KEY?.trim() || "",
    RELAYER_API_KEY: process.env.RELAYER_API_KEY?.trim() || "",
    RELAYER_API_KEY_ADDRESS: process.env.RELAYER_API_KEY_ADDRESS?.trim() || "",
    POLY_PROXY_ADDRESS: process.env.POLY_PROXY_ADDRESS?.trim() || "",
};

export function requirePrivateKey(): string {
    const key = CONFIG.PRIVATE_KEY;
    if (!key) throw new Error("PRIVATE_KEY is required for this operation.");
    try {
        privateKeyToAccount(key as `0x${string}`);
    } catch {
        throw new Error("PRIVATE_KEY must be a valid EVM private key.");
    }
    return key;
}

export const isProxyEnabled = (): boolean => Boolean(CONFIG.POLY_PROXY_ADDRESS);

const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as Address;
const ERC20_BALANCE_ABI = [{
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
}] as const;

let providerInstance: ReturnType<typeof createPublicClient> | null = null;

export const getRpcProvider = () => {
    if (!providerInstance) {
        if (CONFIG.RPC_URLS.length === 0) throw new Error("Set RPC_URL or at least one backup RPC_URL_n.");
        const transports = CONFIG.RPC_URLS.map((url) => http(url));
        providerInstance = createPublicClient({
            chain: polygon,
            transport: transports.length === 1 ? transports[0] : fallback(transports),
        });
    }
    return providerInstance;
};

export const getPusdBalance = async (address: string): Promise<bigint> => {
    return getRpcProvider().readContract({
        address: PUSD_ADDRESS,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [address as Address],
    } as any) as Promise<bigint>;
};
