import { ClobClient } from "@polymarket/clob-client";
import { RelayClient } from "@polymarket/builder-relayer-client";

export interface Strategy {
    name: string;
    init(clobClient: ClobClient, relayClient: RelayClient): Promise<void>;
    run(): Promise<void>;
    cleanup(): Promise<void>;
}
