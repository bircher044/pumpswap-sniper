import { globalConfigPda, PUMP_AMM_PROGRAM_ID_PUBKEY, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AccountMeta, Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

export function getBuyIx(
    pool: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    user: PublicKey,
    baseAmountOut: bigint,
    maxQuoteAmountIn: bigint,
    coinCreator = new PublicKey("11111111111111111111111111111111"),
    protocolFeeRecipient = new PublicKey("7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ"),
    programId = PUMP_AMM_PROGRAM_ID_PUBKEY,
    baseTokenProgramId = TOKEN_PROGRAM_ID,
    quoteTokenProgramId = TOKEN_PROGRAM_ID
): TransactionInstruction {
    const coinCreatorVaultAuthorityPubkey = PublicKey.findProgramAddressSync(
        [Buffer.from([99, 114, 101, 97, 116, 111, 114, 95, 118, 97, 117, 108, 116]), coinCreator.toBuffer()],
        programId
    )[0];

    const keys: Array<AccountMeta> = [
        {
            pubkey: pool,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: user,
            isSigner: true,
            isWritable: true,
        },
        {
            pubkey: globalConfigPda(programId)[0],
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: baseMint,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: quoteMint,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: getAssociatedTokenAddressSync(baseMint, user, false, baseTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: getAssociatedTokenAddressSync(quoteMint, user, false, quoteTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: getAssociatedTokenAddressSync(baseMint, pool, true, baseTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: getAssociatedTokenAddressSync(quoteMint, pool, true, quoteTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: protocolFeeRecipient,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: PublicKey.findProgramAddressSync(
                [protocolFeeRecipient.toBuffer(), quoteTokenProgramId.toBuffer(), quoteMint.toBuffer()],
                new PublicKey([
                    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123,
                    216, 219, 233, 248, 89,
                ])
            )[0],
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: baseTokenProgramId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: quoteTokenProgramId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: PublicKey.findProgramAddressSync(
                [Buffer.from([95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121])],
                programId
            )[0],
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: programId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: PublicKey.findProgramAddressSync(
                [coinCreatorVaultAuthorityPubkey.toBuffer(), quoteTokenProgramId.toBuffer(), quoteMint.toBuffer()],
                new PublicKey([
                    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123,
                    216, 219, 233, 248, 89,
                ])
            )[0],
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: coinCreatorVaultAuthorityPubkey,
            isSigner: false,
            isWritable: false,
        },
    ];

    const data = Buffer.alloc(8 + 8 + 8);
    data.set([102, 6, 61, 18, 1, 218, 235, 234], 0);
    data.writeBigUInt64LE(baseAmountOut, 8);
    data.writeBigUInt64LE(maxQuoteAmountIn, 16);

    return new TransactionInstruction({
        keys,
        data,
        programId,
    });
}

export function getSellIx(
    pool: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    user: PublicKey,
    baseAmountIn: bigint,
    minQuoteAmountOut: bigint,
    coinCreator = new PublicKey("11111111111111111111111111111111"),
    protocolFeeRecipient = new PublicKey("7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ"),
    programId = PUMP_AMM_PROGRAM_ID_PUBKEY,
    baseTokenProgramId = TOKEN_PROGRAM_ID,
    quoteTokenProgramId = TOKEN_PROGRAM_ID
): TransactionInstruction {
    const coinCreatorVaultAuthorityPubkey = PublicKey.findProgramAddressSync(
        [Buffer.from([99, 114, 101, 97, 116, 111, 114, 95, 118, 97, 117, 108, 116]), coinCreator.toBuffer()],
        programId
    )[0];

    const keys: Array<AccountMeta> = [
        {
            pubkey: pool,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: user,
            isSigner: true,
            isWritable: true,
        },
        {
            pubkey: globalConfigPda(programId)[0],
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: baseMint,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: quoteMint,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: getAssociatedTokenAddressSync(baseMint, user, false, baseTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: getAssociatedTokenAddressSync(quoteMint, user, false, quoteTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: getAssociatedTokenAddressSync(baseMint, pool, true, baseTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: getAssociatedTokenAddressSync(quoteMint, pool, true, quoteTokenProgramId),
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: protocolFeeRecipient,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: PublicKey.findProgramAddressSync(
                [protocolFeeRecipient.toBuffer(), quoteTokenProgramId.toBuffer(), quoteMint.toBuffer()],
                new PublicKey([
                    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123,
                    216, 219, 233, 248, 89,
                ])
            )[0],
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: baseTokenProgramId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: quoteTokenProgramId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: PublicKey.findProgramAddressSync(
                [Buffer.from([95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121])],
                programId
            )[0],
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: programId,
            isSigner: false,
            isWritable: false,
        },
        {
            pubkey: PublicKey.findProgramAddressSync(
                [coinCreatorVaultAuthorityPubkey.toBuffer(), quoteTokenProgramId.toBuffer(), quoteMint.toBuffer()],
                new PublicKey([
                    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123,
                    216, 219, 233, 248, 89,
                ])
            )[0],
            isSigner: false,
            isWritable: true,
        },
        {
            pubkey: coinCreatorVaultAuthorityPubkey,
            isSigner: false,
            isWritable: false,
        },
    ];

    const data = Buffer.alloc(8 + 8 + 8);
    data.set([51, 230, 133, 164, 1, 127, 131, 173], 0);
    data.writeBigUInt64LE(baseAmountIn, 8);
    data.writeBigUInt64LE(minQuoteAmountOut, 16);

    return new TransactionInstruction({
        keys,
        data,
        programId,
    });
}

export async function calculateBaseFromQuote(connection: Connection, pool: PublicKey, quoteAmount: BN, slippage: number) {
    const sdk = new PumpAmmSdk(connection);
    const baseAmountOut = await sdk.swapAutocompleteBaseFromQuote(pool, quoteAmount, slippage, "quoteToBase");

    return baseAmountOut;
}
