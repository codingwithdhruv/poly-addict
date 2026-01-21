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

export interface BuilderCreds {
    key: string;
    secret: string;
    passphrase: string;
}

const getBuilderCreds = (): BuilderCreds[] => {
    const creds: BuilderCreds[] = [];

    const tryAdd = (k?: string, s?: string, p?: string) => {
        if (k && s && p) {
            // Avoid duplicates? Simple check might be good, but assuming envs are distinct sets
            // We just push.
            creds.push({ key: k, secret: s, passphrase: p });
        }
    };

    // Primary (Legacy or Base 'apiKey')
    // We try all primary variants
    const k1 = process.env.POLY_BUILDER_API_KEY || process.env.BUILDER_API_KEY || process.env.apiKey || process.env.apiKey1;
    const s1 = process.env.POLY_BUILDER_SECRET || process.env.BUILDER_SECRET || process.env.apiSecret || process.env.apiSecret1;
    const p1 = process.env.POLY_BUILDER_PASSPHRASE || process.env.BUILDER_PASS_PHRASE || process.env.apiPassphrase || process.env.apiPassphrase1;

    tryAdd(k1, s1, p1);

    // Secondaries (2 to 5)
    for (let i = 2; i <= 5; i++) {
        const k = process.env[`POLY_BUILDER_API_KEY_${i}`] || process.env[`BUILDER_API_KEY_${i}`] || process.env[`apiKey${i}`];
        const s = process.env[`POLY_BUILDER_SECRET_${i}`] || process.env[`BUILDER_SECRET_${i}`] || process.env[`apiSecret${i}`];
        const p = process.env[`POLY_BUILDER_PASSPHRASE_${i}`] || process.env[`BUILDER_PASS_PHRASE_${i}`] || process.env[`apiPassphrase${i}`];

        tryAdd(k, s, p);
    }

    return creds;
}

export const CONFIG = {
    HOST: "https://clob.polymarket.com",
    RELAYER_URL: "https://relayer-v2.polymarket.com/",
    CHAIN_ID: 137, // Polygon mainnet
    RPC_URL: process.env.RPC_URL || "", // Legacy single URL accessor, potentially empty if only indexed used
    RPC_URLS: getRpcUrls(),
    PRIVATE_KEY: getEnvParam("PRIVATE_KEY"),

    // Legacy accessors
    POLY_BUILDER_API_KEY: process.env.POLY_BUILDER_API_KEY || getEnvParam("BUILDER_API_KEY"),
    POLY_BUILDER_SECRET: process.env.POLY_BUILDER_SECRET || getEnvParam("BUILDER_SECRET"),
    POLY_BUILDER_PASSPHRASE: process.env.POLY_BUILDER_PASSPHRASE || getEnvParam("BUILDER_PASS_PHRASE"),

    // New list
    BUILDER_CREDS_LIST: getBuilderCreds(),

    // Optional: Proxy / Gnosis Safe Configuration
    // If set, the bot will act as this proxy address
    POLY_PROXY_ADDRESS: process.env.POLY_PROXY_ADDRESS,
};

export const isProxyEnabled = (): boolean => {
    return !!CONFIG.POLY_PROXY_ADDRESS;
}
