import { EventEmitter } from "events";
import * as dotenv from "dotenv";
import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
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
import type { ClientDuplexStream } from "@grpc/grpc-js";
import type { SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";

import { decodeSystemTransferIx } from "./system-program";
import { loadBuyersCsv, loadTargetsCsv, writeTargetsCsv } from "./utils/read-csv";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";
import { getDate } from "./utils/date";
dotenv.config();
const connection = new Connection(process.env.RPC_URL!, "processed");

const ZERO_SLOT_TIP = 0.001 * LAMPORTS_PER_SOL;
const SELL_PRIORITY_FEE = 50000; // micro lamports
const SELL_MIN_AMOUNT = BigInt(0.001 * LAMPORTS_PER_SOL);

const QUOTE_AMOUNT_OUT = BigInt(0);
const TRANSFER_MIN_AMOUNT = 100 * LAMPORTS_PER_SOL;

let currentBuyerIndex = 0;
const MAX_PROFIT_RUG_DIFFERENCE = 3;

const eventEmitter = new EventEmitter();
const pumpswapCoder = new BorshCoder(pumpswap);

let buyers: Keypair[] = [];

let targets: PublicKey[] = [];
let profits: number[] = [];
let rugs: number[] = [];
let timeouts: number[] = [];
let buyAmountSol: number[] = [];
let takeProfitSol: number[] = [];
let timeoutMs: number[] = [];
let lastUpdate: string[] = [];

const client = new Client(process.env.GRPC_URL!, undefined, {
    "grpc.max_receive_message_length": 1024 * 1024 * 1024,
});

let stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;

async function startSubscription() {
    if (stream) {
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

        stream.end();
        await streamClosed;
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

    const hasThirdPartyProgram = grpcResponse.transaction.transaction.message.instructions.some((ix) => {
        if (accountKeys[ix.programIdIndex].toBase58() === SYSTEM_PROGRAM_ID.toBase58()) return false;
        if (accountKeys[ix.programIdIndex].toBase58() === ComputeBudgetProgram.programId.toBase58()) return false;
        return true;
    });
    if (!hasThirdPartyProgram) {
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
        new PublicKey(keys[createIx.accounts[2]]),
        currentBuyerIndex,
        grpcResponse.transaction.transaction.message.recentBlockhash
    );
    currentBuyerIndex = (currentBuyerIndex + 1) % buyers.length;
});

eventEmitter.on(
    "pool",
    async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, creator: PublicKey, buyerIndex: number, recentBlockhash: string) => {
        try {
            const creatorIndex = targets.findIndex((target) => target.toBase58() === creator.toBase58());
            if (rugs[creatorIndex] - profits[creatorIndex] > MAX_PROFIT_RUG_DIFFERENCE) {
                console.log("Skipping pool due to high profit/rug difference for creator", creator.toBase58());
                return;
            }

            const wsolAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);
            const tokenAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);

            console.log(`buy amount for buyer ${buyerIndex}:`, buyAmountSol[creatorIndex]);

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
                            lamports: BigInt(buyAmountSol[creatorIndex] * LAMPORTS_PER_SOL) + BigInt(10001),
                        }),
                        createSyncNativeInstruction(wsolAta),
                        createAssociatedTokenAccountIdempotentInstruction(
                            buyers[buyerIndex].publicKey,
                            tokenAta,
                            buyers[buyerIndex].publicKey,
                            quoteMint
                        ),
                        getSellIx(
                            pool,
                            baseMint,
                            quoteMint,
                            buyers[buyerIndex].publicKey,
                            BigInt(buyAmountSol[creatorIndex] * LAMPORTS_PER_SOL),
                            QUOTE_AMOUNT_OUT
                        ),
                        getTipInstruction(buyers[buyerIndex].publicKey, ZERO_SLOT_TIP),
                    ],
                }).compileToV0Message()
            );

            tx.sign([buyers[buyerIndex]]);
            console.log("buyer", buyers[currentBuyerIndex].publicKey.toBase58());

            await sendTransaction(tx);
            console.log(quoteMint.toBase58(), "buy transaction sent", bs58.encode(tx.signatures[0]));
            eventEmitter.emit("exit", pool, baseMint, quoteMint, buyerIndex, creator);
        } catch (error) {
            console.error("Error processing buy transaction:", error);
            console.error("Pool:", pool.toBase58(), "Base Mint:", baseMint.toBase58(), "Quote Mint:", quoteMint.toBase58());
            console.error("Buyer Index:", buyerIndex);
        }
    }
);

eventEmitter.on("exit", async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyerIndex: number, creator: PublicKey) => {
    try {
        const tokenAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);

        const startTime = Date.now();

        const creatorIndex = targets.findIndex((target) => target.toBase58() === creator.toBase58());
        lastUpdate[creatorIndex] = getDate();

        if (creatorIndex === -1) {
            console.error("invalid creator index", creator.toBase58());
        }

        await new Promise((resolve) => setTimeout(resolve, 4000));
        let tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;
        if (tokenAmount < BigInt(100)) {
            console.log("No tokens to sell (freeze possible).");
            return;
        }

        let shouldSell = false;
        while (!shouldSell) {
            try {
                if (Date.now() - startTime > timeoutMs[creatorIndex]) {
                    console.log("Timeout reached, exiting.");
                    timeouts[creatorIndex] = timeouts[creatorIndex] + 1;
                    break;
                }

                const solAmount = BigInt((await calculateBaseFromQuote(connection, pool, new BN(tokenAmount.toString()), 5)).toString());

                console.log(
                    `token: ${quoteMint}, value: ${(Number(solAmount) / LAMPORTS_PER_SOL).toFixed(4)}, profitTarget: ${Number(
                        takeProfitSol[creatorIndex]
                    ).toFixed(4)}, time left: ${(timeoutMs[creatorIndex] - (Date.now() - startTime)) / 1000} seconds`
                );

                if (solAmount >= BigInt(takeProfitSol[creatorIndex] * LAMPORTS_PER_SOL)) {
                    console.log("Profit target reached.");
                    profits[creatorIndex] = profits[creatorIndex] + 1;
                    shouldSell = true;
                    break;
                }
                if (solAmount < BigInt(10000)) {
                    console.log("YOU GOT RUGGED");
                    rugs[creatorIndex] = rugs[creatorIndex] + 1;

                    writeTargetsCsv("targets.csv", targets, profits, rugs, timeouts, buyAmountSol, takeProfitSol, timeoutMs, lastUpdate);
                    return;
                }
                await new Promise((r) => setTimeout(r, 1000));
            } catch (error) {
                console.error("Error calculating base from quote:", error);
            }
        }

        writeTargetsCsv("targets.csv", targets, profits, rugs, timeouts, buyAmountSol, takeProfitSol, timeoutMs, lastUpdate);

        let solAmount = await calculateBaseFromQuote(connection, pool, new BN(tokenAmount.toString()), 10);

        for (let i = 0; i < 5; i++) {
            try {
                if (BigInt(solAmount.toString()) < SELL_MIN_AMOUNT) {
                    break;
                }
                eventEmitter.emit("sell", pool, baseMint, quoteMint, buyerIndex, solAmount);

                await new Promise((r) => setTimeout(r, 3000));

                solAmount = await calculateBaseFromQuote(connection, pool, new BN(tokenAmount.toString()), 10);
                tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;
            } catch {}
        }
    } catch (error) {
        console.error("Error processing exit:", error);
        console.error("Pool:", pool.toBase58(), "Base Mint:", baseMint.toBase58(), "Quote Mint:", quoteMint.toBase58());
        console.error("Buyer Index:", buyerIndex);
    }
});

eventEmitter.on("sell", async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyerIndex: number, solAmount: BN) => {
    try {
        const tokenAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);
        const tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;
        //const wsolAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);

        const sellTx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: buyers[buyerIndex].publicKey,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                instructions: [
                    getBuyIx(pool, baseMint, quoteMint, buyers[buyerIndex].publicKey, BigInt(solAmount.toString()), BigInt(tokenAmount)),
                    //createCloseAccountInstruction(wsolAta, buyers[buyerIndex].publicKey, buyers[buyerIndex].publicKey),
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: SELL_PRIORITY_FEE,
                    }),
                ],
            }).compileToV0Message()
        );
        sellTx.sign([buyers[buyerIndex]]);
        await connection.sendTransaction(sellTx, {
            skipPreflight: true,
        });
        console.log(quoteMint.toBase58(), "Sell transaction sent", bs58.encode(sellTx.signatures[0]));
    } catch (error) {
        console.error("Error processing sell transaction:", error);
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
            if (!decodedIx) {
                return;
            }

            if (Number(decodedIx.lamports) < TRANSFER_MIN_AMOUNT) {
                return;
            }
            // console.log("Decoded lamports:", Number(decodedIx.lamports) / LAMPORTS_PER_SOL);
            // console.log("from", decodedIx.from, "to", decodedIx.to);
            const index = targets.findIndex((pk) => pk.toBase58() === decodedIx.from);
            if (index !== -1) {
                targets[index] = new PublicKey(decodedIx.to);
                lastUpdate[index] = getDate();
                console.log(`Target updated: ${decodedIx.from} -> ${decodedIx.to}`);

                writeTargetsCsv("targets.csv", targets, profits, rugs, timeouts, buyAmountSol, takeProfitSol, timeoutMs, lastUpdate);

                await startSubscription();
            } else {
                console.log(`Target not found for: ${decodedIx.from}`);
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

async function main() {
    buyers = await loadBuyersCsv("buyers.csv");
    const [
        targetsValues,
        profitsValues,
        rugsValues,
        timeoutsValues,
        buyAmountSolValues,
        takeProfitSolValues,
        timeoutMsValues,
        lastUpdateValues,
    ] = await loadTargetsCsv("targets.csv");

    currentBuyerIndex = Math.floor(Math.random() * buyers.length);
    console.log("Current buyer index:", currentBuyerIndex);
    console.log("date", getDate());
    targets = targetsValues;
    profits = profitsValues;
    rugs = rugsValues;
    timeouts = timeoutsValues;
    buyAmountSol = buyAmountSolValues;
    takeProfitSol = takeProfitSolValues;
    timeoutMs = timeoutMsValues;
    lastUpdate = lastUpdateValues;

    await startSubscription();
    console.log("Subscription started. Waiting for transactions...");
}

main().catch(console.error);
