import dotenv from "dotenv";

dotenv.config();

const getEnvParam = (key: string): string => {
    const value = process.env[key];
    if (!value) {
        throw new Error(`${key} is missing in .env file`);
    }
    return value;
};

const getRpcUrls = (): string[] => {
    const urls: string[] = [];
    const add = (v?: string) => { if (v && !urls.includes(v)) urls.push(v); };

    add(process.env.RPC_URL);

    for (let i = 1; i <= 5; i++) {
        add(process.env[`RPC_URL_${i}`]);
        add(process.env[`polygon_rpc_${i}`]);
    }

    if (urls.length === 0) throw new Error("RPC_URL is missing");
    return urls;
}

export interface RelayerCreds {
    key: string;
    address: string;
}

const getRelayerCreds = (): RelayerCreds[] => {
    const creds: RelayerCreds[] = [];
    const tryAdd = (k?: string, a?: string) => {
        if (k && a && !creds.some(c => c.key === k)) {
            creds.push({ key: k, address: a });
        }
    };

    // Try formats like RELAYER_API_KEY & 1RELAYER_API_KEY
    tryAdd(process.env.RELAYER_API_KEY, process.env.RELAYER_API_KEY_ADDRESS);
    tryAdd(process.env['1RELAYER_API_KEY'], process.env['1RELAYER_API_KEY_ADDRESS']);

    for (let i = 2; i <= 10; i++) {
        tryAdd(process.env[`RELAYER_API_KEY_${i}`], process.env[`RELAYER_API_KEY_ADDRESS_${i}`]);
        tryAdd(process.env[`${i}RELAYER_API_KEY`], process.env[`${i}RELAYER_API_KEY_ADDRESS`]);
    }

    return creds;
};

export const CONFIG = {
    HOST: "https://clob.polymarket.com",
    RELAYER_URL: "https://relayer-v2.polymarket.com/",
    CHAIN_ID: 137, // Polygon mainnet
    RPC_URL: process.env.RPC_URL || "", 
    RPC_URLS: getRpcUrls(),
    PRIVATE_KEY: getEnvParam("PRIVATE_KEY"),

    // Relayer V2 Auth
    RELAYER_API_KEY: process.env.RELAYER_API_KEY || "",
    RELAYER_API_KEY_ADDRESS: process.env.RELAYER_API_KEY_ADDRESS || "",
    RELAYER_CREDS_LIST: getRelayerCreds(),
    POLY_BUILDER_CODE: process.env.POLY_BUILDER_CODE || process.env.BUILDER_CODE || "",

    // Optional: Proxy / Gnosis Safe Configuration
    // If set, the bot will act as this proxy address
    POLY_PROXY_ADDRESS: process.env.POLY_PROXY_ADDRESS,
};

export const isProxyEnabled = (): boolean => {
    return !!CONFIG.POLY_PROXY_ADDRESS;
}

// --- Ethers Helpers for Dashboard ---
import { ethers } from "ethers";

let providerInstance: ethers.providers.JsonRpcProvider | null = null;

export const getRpcProvider = () => {
    if (!providerInstance) {
        providerInstance = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URLS[0]);
    }
    return providerInstance;
};

export const getUsdcContract = () => {
    const usdcAddr = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"; // Polygon pUSD
    const abi = ["function balanceOf(address) view returns (uint256)"];
    return new ethers.Contract(usdcAddr, abi, getRpcProvider());
};
