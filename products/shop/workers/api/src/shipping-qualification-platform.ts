import { protectedConfig } from "./protected-config";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import type { GetPlatformProxyOptions } from "wrangler";
const Config = Schema.Struct({
    name: Schema.String,
    account_id: Schema.Literal(protectedConfig("cloudflareAccountId")),
    compatibility_date: Schema.Literal("2026-08-12"),
    compatibility_flags: Schema.Tuple(Schema.Literal("nodejs_compat")),
    d1_databases: Schema.Tuple(Schema.Struct({ binding: Schema.Literal("DB"), database_name: Schema.String,
        database_id: Schema.String, remote: Schema.Literal(true) })),
    r2_buckets: Schema.Tuple(Schema.Struct({ binding: Schema.Literal("DESIGN_ARTWORK"),
        bucket_name: Schema.Literal("shipping-qualification-artwork"), remote: Schema.Literal(false) })),
});
export async function shippingQualificationOptions(): Promise<{
    options: GetPlatformProxyOptions;
    remote: boolean;
}> {
    const path = process.env["NATIVE_SHIPPING_QUALIFICATION_CONFIG"];
    if (!path)
        return { options: { environment: "", persist: false, remoteBindings: false }, remote: false };
    const run = process.env["GITHUB_RUN_ID"], root = process.env["RUNNER_TEMP"];
    if (process.env["GITHUB_ACTIONS"] !== "true" || process.env["GITHUB_REPOSITORY_ID"] !== protectedConfig("githubRepositoryId") ||
        process.env["GITHUB_REPOSITORY_OWNER_ID"] !== protectedConfig("githubOwnerId") || process.env["GITHUB_EVENT_NAME"] !== "workflow_dispatch" ||
        process.env["GITHUB_REF"] !== "refs/heads/main" || process.env["GITHUB_RUN_ATTEMPT"] !== "1" ||
        process.env["GITHUB_WORKFLOW_REF"] !== "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main" ||
        typeof run !== "string" || !/^[1-9][0-9]*$/.test(run) || !root?.startsWith("/") || path !== `${root}/shipping-qualification/wrangler.json` ||
        !process.env["CLOUDFLARE_API_TOKEN"] || process.env["CLOUDFLARE_ACCOUNT_ID"] !== protectedConfig("cloudflareAccountId"))
        throw new Error("Remote shipping qualification requires its guarded personal Actions context.");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const config = Schema.decodeUnknownSync(Config)(parsed, { onExcessProperty: "error" });
    const database = config.d1_databases[0];
    if (config.name !== `shipping-qualification-${run}` || database.database_name !== `forever-tee-shipping-qualification-${run}` ||
        !/^[a-f0-9-]{36}$/.test(database.database_id) || database.database_id !== process.env["NATIVE_SHIPPING_DATABASE_ID"] ||
        [protectedConfig("resource_fb377032d2f5"), protectedConfig("resource_1a1378f0d1dc")].includes(database.database_id))
        throw new Error("Shipping qualification cannot bind an application database.");
    return { options: { configPath: path, environment: "", envFiles: [], persist: false, remoteBindings: true }, remote: true };
}
export async function verifyShippingQualificationProxy(db: D1Database) {
    const proof = await db.prepare("SELECT run_id, nonce FROM shipping_qualification_proof WHERE singleton=1")
        .first<{
        run_id: string;
        nonce: string;
    }>();
    if (!proof || proof.run_id !== process.env["GITHUB_RUN_ID"] || proof.nonce !== process.env["NATIVE_SHIPPING_DATABASE_NONCE"])
        throw new Error("Remote shipping database provenance was not confirmed.");
    await db.prepare("UPDATE shipping_qualification_proof SET connected=1 WHERE singleton=1 AND run_id=? AND nonce=?")
        .bind(proof.run_id, proof.nonce).run();
}
