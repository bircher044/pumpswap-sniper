import csv from "csv-parser";
import fs from "fs";

export function readCsv<T>(filePath: string, mapFn: (row: Record<string, string>) => T): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const results: T[] = [];

        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (row) => {
                try {
                    results.push(mapFn(row));
                } catch (err) {
                    reject(new Error(`Error processing row: ${JSON.stringify(row)}\n${err}`));
                }
            })
            .on("end", () => resolve(results))
            .on("error", (err: Error) => reject(new Error(`Error reading file "${filePath}": ${err.message}`)));
    });
}
