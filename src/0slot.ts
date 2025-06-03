import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";

export const getTipInstruction = (fromPubkey: PublicKey, lamports: number) => {
    if (lamports < 1000000) throw new Error("Tip amount < 0.001 SOL");
    if (lamports > LAMPORTS_PER_SOL) throw new Error("Tip amount > 1 SOL");

    return SystemProgram.transfer({
        fromPubkey: fromPubkey,
        toPubkey: new PublicKey("4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4"),
        lamports: lamports,
    });
};

export const sendTransaction = async (tx: VersionedTransaction) => {
    const connection0Slot = new Connection(`${process.env.ZEROSLOT_PROXY}`, "processed");

    const hash = await connection0Slot.sendRawTransaction(tx.serialize(), { skipPreflight: true });

    return hash;
};
