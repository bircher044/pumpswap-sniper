import { EventEmitter } from "events";
import * as dotenv from "dotenv";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    getAccount,
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { pumpswap } from "./pumpswapIDL";
import { getTipInstruction, sendTransaction } from "./0slot";
import { GRPCResponse } from "./grpc-response";
import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { convertBuffers } from "./convert-buffer";
import { calculateBaseFromQuote, getBuyIx, getSellIx } from "./pumpswap";
import path from "path";
import fs from "fs";
import type { ClientDuplexStream } from "@grpc/grpc-js";
import type { SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";

import { decodeSystemTransferIx } from "./system-program";
import { readCsv } from "./utils/read-csv";
dotenv.config();

const ZERO_SLOT_TIP = 0.001 * LAMPORTS_PER_SOL;

const BASE_AMOUNT_IN = BigInt(0.01 * LAMPORTS_PER_SOL);
const PROFIT_TARGET = BigInt(0.0185 * LAMPORTS_PER_SOL);

const QUOTE_AMOUNT_OUT = BigInt(0);
const TRANSFER_MIN_AMOUNT = 100 * LAMPORTS_PER_SOL;
const SELL_TIMEOUT = 5 * 60000; ///5 mins
let currentBuyerIndex = 9;

const eventEmitter = new EventEmitter();
const pumpswapCoder = new BorshCoder(pumpswap);

const connection = new Connection(process.env.RPC_URL!, "processed");
let buyers: Keypair[] = [];
let targets: PublicKey[] = [];

const client = new Client(process.env.GRPC_URL!, undefined, {
    "grpc.max_receive_message_length": 1024 * 1024 * 1024,
});

let stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;

async function startSubscription() {
    if (stream) {
        stream.end();
    }

    stream = await client.subscribe();

    const streamClosed = new Promise<void>((resolve, reject) => {
        stream.on("error", (error) => {
            reject(error);
            stream.end();
        });
        stream.on("end", () => {
            resolve();
        });
        stream.on("close", () => {
            resolve();
        });
    });

    stream.on("data", async (data) => {
        if (data) {
            if (data.transaction) {
                const convertedTx = convertBuffers(data.transaction);
                eventEmitter.emit("transaction", convertedTx);
            } else if (!data.ping && !data.pong) console.error("Unknown data received", data);
        } else console.error("No data received");
    });

    await new Promise<void>((resolve, reject) => {
        stream.write(
            {
                commitment: CommitmentLevel.PROCESSED,
                accountsDataSlice: [],
                ping: undefined,
                transactions: {
                    createPool: {
                        vote: false,
                        failed: false,
                        accountInclude: [...targets.map((t) => t.toBase58())],
                        accountExclude: [],
                        accountRequired: [pumpswap.address],
                    },
                    transfer: {
                        vote: false,
                        failed: false,
                        accountInclude: [...targets.map((t) => t.toBase58())],
                        accountExclude: [],
                        accountRequired: [SystemProgram.programId.toBase58()],
                    },
                },
                accounts: {},
                slots: {},
                transactionsStatus: {},
                entry: {},
                blocks: {},
                blocksMeta: {},
            },
            (error: any) => {
                if (error === null || error === undefined) resolve();
                else reject(error);
            }
        );
    });

    console.log("Stream started");

    await streamClosed;

    console.log("Stream closed");
}

eventEmitter.on("transaction", async (grpcResponse: GRPCResponse) => {
    const accountKeys = grpcResponse.transaction.transaction.message.accountKeys.map((key) => new PublicKey(key));

    const isTransferIx = grpcResponse.transaction.transaction.message.instructions.map((ix) => {
        const programId = accountKeys[ix.programIdIndex];
        if (!programId.equals(SystemProgram.programId)) {
            return false;
        }

        const data = bs58.decode(ix.data);
        if (data.length < 8) {
            return false;
        }

        const instruction = data.readUInt32LE(0);
        return instruction === 2;
    });

    if (!isTransferIx.includes(false)) {
        grpcResponse.transaction.transaction.message.instructions.map((ix) => {
            eventEmitter.emit("transfer", ix, accountKeys);
        });
    }

    const createIx = grpcResponse.transaction.transaction.message.instructions.find((i) =>
        pumpswapCoder.instruction.decode(i.data, "base58")?.name.startsWith("create_pool")
    );

    if (!createIx) {
        return;
    }
    const keys = grpcResponse.transaction.transaction.message.accountKeys;
    console.log("Create pool instruction found in transaction", grpcResponse.transaction.transaction.signatures[0]);
    eventEmitter.emit(
        "pool",
        new PublicKey(keys[createIx.accounts[0]]),
        new PublicKey(keys[createIx.accounts[3]]),
        new PublicKey(keys[createIx.accounts[4]]),
        currentBuyerIndex,
        grpcResponse.transaction.transaction.message.recentBlockhash
    );
    currentBuyerIndex = (currentBuyerIndex + 1) % buyers.length;
});

eventEmitter.on("pool", async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyerIndex: number, recentBlockhash: string) => {
    try {
        const wsolAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);
        const tokenAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);

        const tx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: buyers[buyerIndex].publicKey,
                recentBlockhash,
                instructions: [
                    createAssociatedTokenAccountIdempotentInstruction(
                        buyers[buyerIndex].publicKey,
                        wsolAta,
                        buyers[buyerIndex].publicKey,
                        baseMint
                    ),
                    SystemProgram.transfer({
                        fromPubkey: buyers[buyerIndex].publicKey,
                        toPubkey: wsolAta,
                        lamports: BASE_AMOUNT_IN + BigInt(10001),
                    }),
                    createSyncNativeInstruction(wsolAta),
                    createAssociatedTokenAccountIdempotentInstruction(
                        buyers[buyerIndex].publicKey,
                        tokenAta,
                        buyers[buyerIndex].publicKey,
                        quoteMint
                    ),
                    getSellIx(pool, baseMint, quoteMint, buyers[buyerIndex].publicKey, BASE_AMOUNT_IN, QUOTE_AMOUNT_OUT),
                    getTipInstruction(buyers[buyerIndex].publicKey, ZERO_SLOT_TIP),
                ],
            }).compileToV0Message()
        );

        tx.sign([buyers[buyerIndex]]);
        console.log("buyer", buyers[currentBuyerIndex].publicKey.toBase58());

        await sendTransaction(tx);
        console.log(quoteMint.toBase58(), "buy transaction sent", bs58.encode(tx.signatures[0]));
        eventEmitter.emit("exit", pool, baseMint, quoteMint, buyerIndex);
    } catch (error) {
        console.error("Error processing buy transaction:", error);
        console.error("Pool:", pool.toBase58(), "Base Mint:", baseMint.toBase58(), "Quote Mint:", quoteMint.toBase58());
        console.error("Buyer Index:", buyerIndex);
    }
});

eventEmitter.on("exit", async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyerIndex: number) => {
    try {
        const tokenAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);

        const startTime = Date.now();
        let shouldSell = false;

        await new Promise((resolve) => setTimeout(resolve, 2000));
        const tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;
        while (!shouldSell && Date.now() - startTime < SELL_TIMEOUT) {
            try {
                const solAmount = BigInt((await calculateBaseFromQuote(connection, pool, new BN(tokenAmount.toString()), 5)).toString());

                console.log(`solAmount: ${solAmount}, profitTarget: ${PROFIT_TARGET}`);
                if (solAmount >= PROFIT_TARGET) {
                    console.log("Profit target reached.");
                    shouldSell = true;
                    break;
                }
                if (solAmount < BigInt(1000)) {
                    console.log("YOU GOT RUGGED");
                    return;
                }
                await new Promise((r) => setTimeout(r, 1000));
            } catch (error) {
                console.error("Error calculating base from quote:", error);
            }
        }

        if (tokenAmount === BigInt(0)) {
            console.log("No tokens to sell.");
            return;
        }

        const solAmount = await calculateBaseFromQuote(connection, pool, new BN(tokenAmount.toString()), 5);

        const wsolAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);
        const sellTx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: buyers[buyerIndex].publicKey,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                instructions: [
                    getBuyIx(pool, baseMint, quoteMint, buyers[buyerIndex].publicKey, BigInt(solAmount.toString()), BigInt(tokenAmount)),
                    createCloseAccountInstruction(wsolAta, buyers[buyerIndex].publicKey, buyers[buyerIndex].publicKey),
                    getTipInstruction(buyers[buyerIndex].publicKey, ZERO_SLOT_TIP),
                ],
            }).compileToV0Message()
        );
        sellTx.sign([buyers[buyerIndex]]);
        await sendTransaction(sellTx);

        console.log(quoteMint.toBase58(), "Sell transaction sent", bs58.encode(sellTx.signatures[0]));
    } catch (error) {
        console.error("Error processing exit transaction:", error);
        console.error("Pool:", pool.toBase58(), "Base Mint:", baseMint.toBase58(), "Quote Mint:", quoteMint.toBase58());
        console.error("Buyer Index:", buyerIndex);
    }
});

eventEmitter.on(
    "transfer",
    async (
        transferIx: {
            programIdIndex: number;
            accounts: Array<number>;
            data: string;
        },
        accountKeys: PublicKey[]
    ) => {
        try {
            const decodedIx = decodeSystemTransferIx(transferIx, accountKeys);
            //console.log("Decoded transfer instruction:", decodedIx);

            if (Number(decodedIx.lamports) < TRANSFER_MIN_AMOUNT) {
                return;
            }

            const index = targets.findIndex((pk) => pk.toBase58() === decodedIx.from);
            if (index !== -1) {
                targets[index] = new PublicKey(decodedIx.to);

                console.log(`Target updated: ${decodedIx.from} -> ${decodedIx.to}`);

                const targetsFilePath = path.resolve("targets.csv");
                const csvContent = ["targets", ...targets.map((target) => target.toBase58())].join("\n");

                fs.writeFileSync(targetsFilePath, csvContent, "utf8");

                await startSubscription();
            }
        } catch (error) {
            console.error("Error processing transfer instruction:", error);
            console.error("Transfer Instruction:", transferIx);
            console.error(
                "Account Keys:",
                accountKeys.map((key) => key.toBase58())
            );
        }
    }
);

async function loadBuyersAndTargets(buyersFilePath: string, targetsFilePath: string) {
    try {
        const buyers = await readCsv(buyersFilePath, (row) => Keypair.fromSecretKey(bs58.decode(Object.values(row)[0])));
        console.log(`Found ${buyers.length} buyers.`);

        const targets = await readCsv(targetsFilePath, (row) => new PublicKey(Object.values(row)[0]));
        console.log(`Found ${targets.length} targets.`);

        if (buyers.length === 0) {
            console.error("No buyers found in the CSV file.");
        }

        if (targets.length === 0) {
            console.error("No targets found in the CSV file.");
        }

        return { buyers, targets };
    } catch (error) {
        console.error("Failed to load data:", error);
        throw error;
    }
}

async function main() {
    let parsedCsvs = await loadBuyersAndTargets("buyers.csv", "targets.csv");
    buyers = parsedCsvs.buyers;
    targets = parsedCsvs.targets;

    await startSubscription();
    console.log("Subscription started. Waiting for transactions...");
}

main().catch(console.error);
