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
export async function loadTargetsCsv(filePath: string): Promise<[PublicKey[], number[], number[], number[]]> {
    const targets: PublicKey[] = [];
    const profits: number[] = [];
    const rugs: number[] = [];
    const timeouts: number[] = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (row) => {
                try {
                    const address = row["targets"];
                    const profit = row["profits"];
                    const rug = row["rugs"];
                    const timeout = row["timeouts"];

                    if (!address || profit === undefined || rug === undefined || timeout === undefined) {
                        throw new Error("Missing one or more fields in row.");
                    }

                    targets.push(new PublicKey(address));
                    profits.push(Number(profit));
                    rugs.push(Number(rug));
                    timeouts.push(Number(timeout));
                } catch (err) {
                    reject(new Error(`Error processing row: ${JSON.stringify(row)}\n${err}`));
                }
            })
            .on("end", () => {
                resolve([targets, profits, rugs, timeouts]);
            })
            .on("error", (err: Error) => {
                reject(new Error(`Error reading file "${filePath}": ${err.message}`));
            });
    });
}

export async function writeTargetsCsv(
    filePath: string,
    targets: PublicKey[],
    profits: number[],
    rugs: number[],
    timeouts: number[]
): Promise<void> {
    if (targets.length !== profits.length || targets.length !== rugs.length || targets.length !== timeouts.length) {
        throw new Error("All arrays must have the same length.");
    }

    const header = "targets,profits,rugs,timeouts\n";

    const rows = targets.map((target, index) => `${target.toBase58()},${profits[index]},${rugs[index]},${timeouts[index]}`);

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
