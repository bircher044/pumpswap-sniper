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
    NATIVE_MINT,
} from "@solana/spl-token";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { pumpswap } from "./pumpswapIDL";
import { GRPCResponse } from "./grpc-response";
import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { convertBuffers } from "./convert-buffer";
import { getBuyIx, getBaseAmountOutFromQuoteIn, getSellIx, calculateQuoteFromBase } from "./pumpswap";
import type { ClientDuplexStream } from "@grpc/grpc-js";
import type { SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { loadBuyersCsv } from "./utils/read-csv";

dotenv.config();
const connection = new Connection(process.env.RPC_URL!, "processed");

const BUY_AMOUNT = BigInt(0.011 * LAMPORTS_PER_SOL);
const SLIPPAGE = 10;
const SELL_TIMEOUT = 30000; // milliseconds
const PROFIT_TARGET = BigInt(0.02 * LAMPORTS_PER_SOL);

//const ZERO_SLOT_TIP = 0.001 * LAMPORTS_PER_SOL;
const BUY_PRIORITY_FEE = 100000; //micro lamports
const SELL_PRIORITY_FEE = 50000; // micro lamports
const SELL_MIN_AMOUNT = BigInt(0.001 * LAMPORTS_PER_SOL);

let buyers: Keypair[] = [];
let currentBuyerIndex = 0;

let currentInside = 0;
let currentProfits = 0;
let currentRugs = 0;
let currentTimeouts = 0;

const INSIDE_LIMIT = 7;

const eventEmitter = new EventEmitter();
const pumpswapCoder = new BorshCoder(pumpswap);

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
                        accountInclude: [],
                        accountExclude: [],
                        accountRequired: [pumpswap.address],
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
    if (currentInside >= INSIDE_LIMIT) {
        return;
    }

    const createIx = grpcResponse.transaction.transaction.message.instructions.find((i) =>
        pumpswapCoder.instruction.decode(i.data, "base58")?.name.startsWith("create_pool")
    );

    if (!createIx) {
        return;
    }

    if (grpcResponse.transaction.transaction.message.accountKeys[createIx.accounts[4]] !== NATIVE_MINT.toBase58()) {
        console.log(grpcResponse.transaction.transaction.message.accountKeys[createIx.accounts[4]]);
        return;
    }

    const data = pumpswapCoder.instruction.decode(createIx.data, "base58");
    if (!data) {
        console.log("failed to decode");
        return;
    }
    const baseAmount = (data.data as any).base_amount_in as BN;
    const quoteAmount = (data.data as any).quote_amount_in as BN;

    console.log("Create pool instruction found in transaction", grpcResponse.transaction.transaction.signatures[0]);

    eventEmitter.emit(
        "pool",
        new PublicKey(grpcResponse.transaction.transaction.message.accountKeys[createIx.accounts[0]]),
        new PublicKey(grpcResponse.transaction.transaction.message.accountKeys[createIx.accounts[3]]),
        new PublicKey(grpcResponse.transaction.transaction.message.accountKeys[createIx.accounts[4]]),
        new PublicKey(grpcResponse.transaction.transaction.message.accountKeys[createIx.accounts[2]]),
        baseAmount,
        quoteAmount,
        currentBuyerIndex,
        grpcResponse.transaction.transaction.message.recentBlockhash
    );
    currentBuyerIndex = (currentBuyerIndex + 1) % buyers.length;
});

eventEmitter.on(
    "pool",
    async (
        pool: PublicKey,
        baseMint: PublicKey,
        quoteMint: PublicKey,
        creator: PublicKey,
        baseIn: BN,
        quoteIn: BN,
        buyerIndex: number,
        recentBlockhash: string
    ) => {
        try {
            const wsolAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);
            const tokenAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);

            const { minBaseAmountOut } = getBaseAmountOutFromQuoteIn(baseIn, quoteIn, new BN(BUY_AMOUNT.toString()), SLIPPAGE);
            const tx = new VersionedTransaction(
                new TransactionMessage({
                    payerKey: buyers[buyerIndex].publicKey,
                    recentBlockhash,
                    instructions: [
                        createAssociatedTokenAccountIdempotentInstruction(
                            buyers[buyerIndex].publicKey,
                            wsolAta,
                            buyers[buyerIndex].publicKey,
                            quoteMint
                        ),
                        SystemProgram.transfer({
                            fromPubkey: buyers[buyerIndex].publicKey,
                            toPubkey: wsolAta,
                            lamports: BUY_AMOUNT,
                        }),
                        createSyncNativeInstruction(wsolAta),
                        createAssociatedTokenAccountIdempotentInstruction(
                            buyers[buyerIndex].publicKey,
                            tokenAta,
                            buyers[buyerIndex].publicKey,
                            baseMint
                        ),
                        getBuyIx(pool, baseMint, quoteMint, buyers[buyerIndex].publicKey, BigInt(minBaseAmountOut.toString()), BUY_AMOUNT),
                        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BUY_PRIORITY_FEE }),
                        //getTipInstruction(buyers[buyerIndex].publicKey, ZERO_SLOT_TIP),
                    ],
                }).compileToV0Message()
            );

            tx.sign([buyers[buyerIndex]]);
            console.log("buyer", buyers[currentBuyerIndex].publicKey.toBase58());

            const id = await connection.sendTransaction(tx, { skipPreflight: true });
            console.log(quoteMint.toBase58(), "buy transaction sent", bs58.encode(tx.signatures[0]));

            const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
            await connection
                .confirmTransaction({ blockhash: recentBlockhash, lastValidBlockHeight: lastValidBlockHeight, signature: id }, "processed")
                .catch();
            eventEmitter.emit("exit", pool, baseMint, quoteMint, buyerIndex, creator);
        } catch (error) {
            console.error("Error processing buy transaction:", error);
            console.error("Pool:", pool.toBase58(), "Base Mint:", baseMint.toBase58(), "Quote Mint:", quoteMint.toBase58());
            console.error("Buyer Index:", buyerIndex);
        }
    }
);

eventEmitter.on("exit", async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyerIndex: number, creator: PublicKey) => {
    currentInside = currentInside + 1;
    try {
        const tokenAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);

        const startTime = Date.now();

        //await new Promise((resolve) => setTimeout(resolve, 4000));
        let tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;
        if (tokenAmount < BigInt(100)) {
            console.log("No tokens to sell (freeze possible).");
            currentInside--;
            return;
        }

        let shouldSell = false;
        while (!shouldSell) {
            try {
                if (Date.now() - startTime > SELL_TIMEOUT) {
                    console.log("Timeout reached, exiting.");
                    currentTimeouts++;
                    shouldSell = true;
                    break;
                }

                const solAmount = BigInt((await calculateQuoteFromBase(connection, pool, new BN(tokenAmount.toString()), 5)).toString());

                console.log(
                    `token: ${baseMint}, value: ${(Number(solAmount) / LAMPORTS_PER_SOL).toFixed(4)}, profitTarget: ${Number(
                        Number(PROFIT_TARGET) / LAMPORTS_PER_SOL
                    ).toFixed(4)}, time left: ${(SELL_TIMEOUT - (Date.now() - startTime)) / 1000} seconds`
                );

                if (solAmount >= PROFIT_TARGET) {
                    console.log("Profit target reached.");
                    currentProfits++;
                    shouldSell = true;
                    break;
                }
                if (solAmount < BigInt(100000)) {
                    currentRugs++;
                    console.log("YOU GOT RUGGED");
                    break;
                }
                await new Promise((r) => setTimeout(r, 1000));
            } catch (error) {
                console.error("Error calculating base from quote:", error);
            }
        }
        if (shouldSell) {
            let solAmount = await calculateQuoteFromBase(connection, pool, new BN(tokenAmount.toString()), 10);

            for (let i = 0; i < 5; i++) {
                try {
                    if (BigInt(solAmount.toString()) < SELL_MIN_AMOUNT) {
                        break;
                    }
                    eventEmitter.emit("sell", pool, baseMint, quoteMint, buyerIndex);

                    await new Promise((r) => setTimeout(r, 3000));

                    solAmount = await calculateQuoteFromBase(connection, pool, new BN(tokenAmount.toString()), 10);
                    tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;
                } catch {}
            }
        }
    } catch (error) {
        console.error("Error processing exit:", error);
        console.error("Pool:", pool.toBase58(), "Base Mint:", baseMint.toBase58(), "Quote Mint:", quoteMint.toBase58());
        console.error("Buyer Index:", buyerIndex);
    }
    currentInside = currentInside - 1;
});

eventEmitter.on("sell", async (pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, buyerIndex: number) => {
    try {
        const tokenAta = getAssociatedTokenAddressSync(baseMint, buyers[buyerIndex].publicKey);
        const wsolAta = getAssociatedTokenAddressSync(quoteMint, buyers[buyerIndex].publicKey);
        const tokenAmount = (await getAccount(connection, tokenAta, "processed")).amount;

        const sellTx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: buyers[buyerIndex].publicKey,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                instructions: [
                    getSellIx(pool, baseMint, quoteMint, buyers[buyerIndex].publicKey, tokenAmount, BigInt(0)),
                    createCloseAccountInstruction(wsolAta, buyers[buyerIndex].publicKey, buyers[buyerIndex].publicKey),
                    createCloseAccountInstruction(tokenAta, buyers[buyerIndex].publicKey, buyers[buyerIndex].publicKey),
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
        console.log("Sell transaction sent", bs58.encode(sellTx.signatures[0]));
    } catch (error) {
        console.error("Error processing sell transaction:", error);
    }
});

function setupConsoleInput() {
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (input: string) => {
        const command = input.trim().toLowerCase();

        switch (command) {
            case "stop":
                currentInside += 10000;
                console.log("🛑 Buying stopped. Will only sell.");
                break;
            case "start":
                currentInside -= 10000;
                console.log("▶️ Resumed buying.");
                break;
            case "exit":
                console.log("🚪 Exiting gracefully...");
                process.exit(0);
            default:
                console.log(`❓ Unknown command: "${command}". Try "stop", "start", or "exit".`);
        }
    });
}

async function main() {
    setupConsoleInput();
    //write current inside every 60 seconds

    setInterval(() => {
        console.log(`CurrentInside: ${currentInside}`);
        console.log(`CurrentProfits: ${currentProfits}`);
        console.log(`CurrentRugs: ${currentRugs}`);
        console.log(`CurrentTimeouts: ${currentTimeouts}`);
    }, 60000);

    buyers = await loadBuyersCsv("buyers.csv");

    currentBuyerIndex = Math.floor(Math.random() * buyers.length);
    console.log("Current buyer index:", currentBuyerIndex);
    await startSubscription();
    console.log("Subscription started. Waiting for transactions...");
}

main().catch(console.error);
