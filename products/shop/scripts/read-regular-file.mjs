import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Inspect and read one open file description. A path swap cannot redirect the
// read after validation; symlinks and special files are never accepted.
export async function readRegularFile(path, { maxBytes = Infinity, minBytes = 0, privateOnly = false,
    message = "An ordinary file with the required size and permissions is required." } = {}) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (error) {
        if (error.code === "ELOOP") throw new Error(message);
        throw error;
    }
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < minBytes || info.size > maxBytes || privateOnly && (info.mode & 0o077) !== 0)
            throw new Error(message);
        const bytes = Number.isFinite(maxBytes)
            ? await readBounded(handle, maxBytes)
            : await handle.readFile();
        const after = await handle.stat();
        if (bytes.length < minBytes || bytes.length > maxBytes || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs)
            throw new Error("File changed while its evidence was being read.");
        return bytes;
    }
    finally {
        await handle.close();
    }
}

async function readBounded(handle, maxBytes) {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
    }
    return buffer.subarray(0, length);
}
