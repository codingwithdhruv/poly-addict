import type { ClobClient } from "../clients/clob.js";

export interface Strategy {
    name: string;
    init(clobClient: ClobClient): Promise<void>;
    run(): Promise<void>;
    cleanup(): Promise<void>;
}
