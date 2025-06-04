import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Keypair, PublicKey } from "@solana/web3.js";
import csv from "csv-parser";
import fs from "fs";

export async function loadBuyersCsv(filePath: string): Promise<Keypair[]> {
    const buyers: Keypair[] = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (row) => {
                try {
                    const encoded = row["buyers"];
                    if (!encoded) {
                        throw new Error("Missing buyer entry.");
                    }
                    const keypair = Keypair.fromSecretKey(bs58.decode(encoded));
                    buyers.push(keypair);
                } catch (err) {
                    reject(new Error(`Error processing row: ${JSON.stringify(row)}\n${err}`));
                }
            })
            .on("end", () => resolve(buyers))
            .on("error", (err: Error) => reject(new Error(`Error reading file "${filePath}": ${err.message}`)));
    });
}
export async function loadTargetsCsv(
    filePath: string
): Promise<[PublicKey[], number[], number[], number[], number[], number[], number[], string[]]> {
    const targets: PublicKey[] = [];
    const profits: number[] = [];
    const rugs: number[] = [];
    const timeouts: number[] = [];
    const buyAmountSol: number[] = [];
    const takeProfitSol: number[] = [];
    const timeoutMs: number[] = [];
    const lastUpdate: string[] = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (row) => {
                try {
                    const address = row["targets"];
                    const profit = row["profits"];
                    const rug = row["rugs"];
                    const timeout = row["timeouts"];
                    const buyAmount = row["buyAmountSol"];
                    const takeProfit = row["takeProfitSol"];
                    const timeoutMsValue = row["timeoutMs"];
                    const lastUpdateValue = row["lastUpdate"];

                    if (
                        !address ||
                        profit === undefined ||
                        rug === undefined ||
                        timeout === undefined ||
                        buyAmount === undefined ||
                        timeoutMsValue === undefined ||
                        takeProfit === undefined ||
                        lastUpdateValue === undefined
                    ) {
                        throw new Error("Missing one or more fields in row.");
                    }

                    targets.push(new PublicKey(address));
                    profits.push(Number(profit));
                    rugs.push(Number(rug));
                    timeouts.push(Number(timeout));
                    buyAmountSol.push(Number(buyAmount));
                    takeProfitSol.push(Number(takeProfit));
                    timeoutMs.push(Number(timeoutMsValue));
                    lastUpdate.push(lastUpdateValue);
                } catch (err) {
                    reject(new Error(`Error processing row: ${JSON.stringify(row)}\n${err}`));
                }
            })
            .on("end", () => {
                resolve([targets, profits, rugs, timeouts, buyAmountSol, takeProfitSol, timeoutMs, lastUpdate]);
            })
            .on("error", (err: Error) => {
                reject(new Error(`Error reading file "${filePath}": ${err.message}`));
            });
    });
} //AuwukFJynq5u1h35fhQ5PrPjPuA1MAjDCTkhEh8ZWRx5

export async function writeTargetsCsv(
    filePath: string,
    targets: PublicKey[],
    profits: number[],
    rugs: number[],
    timeouts: number[],
    buyAmountSol: number[],
    takeProfitSol: number[],
    timeoutMs: number[],
    lastUpdate: string[]
): Promise<void> {
    if (
        targets.length !== profits.length ||
        targets.length !== rugs.length ||
        targets.length !== timeouts.length ||
        targets.length !== buyAmountSol.length ||
        targets.length !== timeoutMs.length ||
        targets.length !== takeProfitSol.length ||
        targets.length !== lastUpdate.length
    ) {
        throw new Error("All arrays must have the same length.");
    }

    const header = "targets,profits,rugs,timeouts,buyAmountSol,takeProfitSol,timeoutMs,lastUpdate\n";

    const rows = targets.map(
        (target, index) =>
            `${target.toBase58()},${profits[index]},${rugs[index]},${timeouts[index]},${buyAmountSol[index]},${takeProfitSol[index]},${
                timeoutMs[index]
            },${lastUpdate[index]}`
    );

    const csvContent = header + rows.join("\n");

    return new Promise((resolve, reject) => {
        fs.writeFile(filePath, csvContent, "utf8", (err) => {
            if (err) {
                reject(new Error(`Error writing to file "${filePath}": ${err.message}`));
            } else {
                resolve();
            }
        });
    });
}
