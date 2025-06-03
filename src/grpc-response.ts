export interface GRPCResponse {
    transaction: {
        signature: string;
        isVote: boolean;
        transaction: {
            signatures: string[];
            message: {
                header: {
                    numRequiredSignatures: number;
                    numReadonlySignedAccounts: number;
                    numReadonlyUnsignedAccounts: number;
                };
                accountKeys: string[];
                recentBlockhash: string;
                instructions: Array<{
                    programIdIndex: number;
                    accounts: Array<number>;
                    data: string;
                }>;
                versioned: boolean;
                addressTableLookups: any[];
            };
        };
        meta: {
            fee: string;
            preBalances: string[];
            postBalances: string[];
            innerInstructions: Array<{
                index: number;
                instructions: Array<{
                    programIdIndex: number;
                    accounts: string;
                    data: string;
                    stackHeight: number;
                }>;
            }>;
            innerInstructionsNone?: boolean;
            logMessages: string[];
            logMessagesNone?: boolean;
            preTokenBalances: any[];
            postTokenBalances: any[];
            rewards: any[];
            loadedWritableAddresses?: any[];
            loadedReadonlyAddresses?: any[];
            returnDataNone?: boolean;
            computeUnitsConsumed: string;
        };
        index: string;
    };
    slot: string;
}
