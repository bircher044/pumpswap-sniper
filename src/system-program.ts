import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { PublicKey, SystemProgram } from "@solana/web3.js";

export function decodeSystemTransferIx(ix: { programIdIndex: number; accounts: number[]; data: string }, accountKeys: PublicKey[]) {
    const programId = accountKeys[ix.programIdIndex];
    if (!programId.equals(SystemProgram.programId)) {
        return null;
    }

    const data = bs58.decode(ix.data);
    const instruction = data.readUInt32LE(0);
    if (instruction !== 2) {
        return null;
    }

    const lamports = data.readBigUInt64LE(4);

    const fromPubkey = accountKeys[ix.accounts[0]];
    const toPubkey = accountKeys[ix.accounts[1]];

    return {
        from: fromPubkey.toBase58(),
        to: toPubkey.toBase58(),
        lamports: lamports.toString(),
    };
}
