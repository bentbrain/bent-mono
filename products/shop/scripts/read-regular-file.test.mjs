import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegularFile } from "./read-regular-file.mjs";

test("evidence reads reject symlinks, non-files, oversized and non-private content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "regular-file-test-"));
    try {
        const path = join(directory, "receipt.json"), link = join(directory, "link.json");
        await writeFile(path, "{}", { mode: 0o600 });
        assert.equal((await readRegularFile(path, { minBytes: 1, maxBytes: 2, privateOnly: true })).toString(), "{}");
        await symlink(path, link);
        await assert.rejects(readRegularFile(link));
        await assert.rejects(readRegularFile(directory), /ordinary/);
        await assert.rejects(readRegularFile(path, { maxBytes: 1 }), /ordinary/);
        await assert.rejects(readRegularFile(path, { minBytes: 3 }), /ordinary/);
        await chmod(path, 0o644);
        await assert.rejects(readRegularFile(path, { privateOnly: true }), /ordinary/);
        await assert.rejects(readRegularFile(join(directory, "missing")), { code: "ENOENT" });
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
