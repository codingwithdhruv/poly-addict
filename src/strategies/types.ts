import { ClobClient } from "@polymarket/clob-client-v2";

export interface Strategy {
    name: string;
    init(clobClient: ClobClient): Promise<void>;
    run(): Promise<void>;
    cleanup(): Promise<void>;
}
