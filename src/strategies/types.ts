import { ClobClient } from "@polymarket/clob-client";

export interface Strategy {
    name: string;
    init(clobClient: ClobClient): Promise<void>;
    run(): Promise<void>;
    cleanup(): Promise<void>;
}
