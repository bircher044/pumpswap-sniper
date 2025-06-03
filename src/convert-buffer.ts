import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

export function convertBuffers(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    // Handle Buffer objects
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
        return bs58.encode(new Uint8Array(obj.data));
    }

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map((item) => convertBuffers(item));
    }

    // Handle objects
    if (typeof obj === "object") {
        // Handle Uint8Array directly
        if (obj instanceof Uint8Array) {
            return bs58.encode(obj);
        }

        const converted: any = {};
        for (const [key, value] of Object.entries(obj)) {
            // Skip certain keys that shouldn't be converted
            if (key === "uiAmount" || key === "decimals" || key === "uiAmountString") {
                converted[key] = value;
            } else if (key === "accounts") {
                converted[key] = Array.from(new Uint8Array(value as Buffer));
            } else {
                converted[key] = convertBuffers(value);
            }
        }
        return converted;
    }

    return obj;
}
