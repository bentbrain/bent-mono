import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { Effect, Schema } from "effect";
import { pathToFileURL } from "node:url";
const PRINTIFY_ORIGIN = "https://api.printify.com";
const WEBHOOK_URL = "https://forever-tee-api.socialqueue.workers.dev/v2/webhooks/printify/order-shipment";
const TOPICS = [
    "order:shipment:created",
    "order:shipment:delivered",
];
const NonEmptyText = Schema.String.pipe(Schema.minLength(1));
const WebhookId = NonEmptyText.pipe(Schema.filter((value) => /^[A-Za-z0-9_-]{8,128}$/u.test(value)));
const HttpsUrl = Schema.String.pipe(Schema.filter((value) => {
    try {
        return new URL(value).protocol === "https:";
    }
    catch {
        return false;
    }
}));
const Webhook = Schema.Struct({
    id: WebhookId,
    shop_id: Schema.Union(Schema.String, Schema.Number),
    topic: NonEmptyText,
    url: HttpsUrl,
});
const WebhookList = Schema.Array(Webhook);
const stopped = (reason) => new Error(`Printify webhook configuration stopped: ${reason}`);
const assertContext = (env) => {
    if (env.GITHUB_ACTIONS !== "true" ||
        env.GITHUB_REPOSITORY !== "bentbrain/bent-mono" ||
        env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") ||
        env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
        env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
        env.GITHUB_REF !== "refs/heads/main" ||
        env.GITHUB_RUN_ATTEMPT !== "1" ||
        env.GITHUB_WORKFLOW_REF !==
            "bentbrain/bent-mono/.github/workflows/configure-printify-webhooks.yml@refs/heads/main") {
        throw stopped("exact first-attempt Production Actions context required.");
    }
    if (!["apply", "plan"].includes(env.PRINTIFY_WEBHOOK_OPERATION)) {
        throw stopped("operation must be plan or apply.");
    }
    if (!/^\d+$/u.test(env.PRINTIFY_SHOP_ID ?? "")) {
        throw stopped("numeric Printify shop ID required.");
    }
    if (typeof env.PRINTIFY_API_TOKEN !== "string" ||
        env.PRINTIFY_API_TOKEN.length === 0 ||
        typeof env.PRINTIFY_WEBHOOK_SECRET !== "string" ||
        env.PRINTIFY_WEBHOOK_SECRET.length < 32) {
        throw stopped("protected Printify credentials required.");
    }
};
const requestJson = (request, url, options, label) => Effect.tryPromise({
    try: () => request(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
    }),
    catch: () => stopped(`${label} response was not confirmed.`),
}).pipe(Effect.flatMap((response) => {
    if (!response.ok) {
        response.body?.cancel();
        return Effect.fail(stopped(`${label} returned HTTP ${response.status}.`));
    }
    return Effect.tryPromise({
        try: () => response.json(),
        catch: () => stopped(`${label} response was not valid JSON.`),
    });
}));
const decodeWebhookList = (value) => Schema.decodeUnknown(WebhookList)(value).pipe(Effect.mapError(() => stopped("webhook inventory response was invalid.")));
const decodeWebhook = (value) => Schema.decodeUnknown(Webhook)(value).pipe(Effect.mapError(() => stopped("webhook write response was invalid.")));
const verifiedDesired = (webhooks, shopId) => {
    const result = [];
    for (const topic of TOPICS) {
        const matches = webhooks.filter((webhook) => webhook.topic === topic);
        if (matches.length !== 1) {
            throw stopped(`expected exactly one ${topic} subscription.`);
        }
        const webhook = matches[0];
        if (String(webhook.shop_id) !== shopId || webhook.url !== WEBHOOK_URL) {
            throw stopped(`${topic} subscription differs from the reviewed destination.`);
        }
        result.push({ id: webhook.id, topic, url: webhook.url });
    }
    return result;
};
const planDesired = (webhooks) => TOPICS.map((topic) => {
    const matches = webhooks.filter((webhook) => webhook.topic === topic);
    if (matches.length > 1) {
        throw stopped(`duplicate ${topic} subscriptions require manual review.`);
    }
    return {
        action: matches.length === 0 ? "create" : "refresh",
        id: matches[0]?.id,
        topic,
        url: WEBHOOK_URL,
    };
});
export async function configurePrintifyWebhooks(env = process.env, request = fetch) {
    assertContext(env);
    const shopId = env.PRINTIFY_SHOP_ID;
    const collectionUrl = `${PRINTIFY_ORIGIN}/v1/shops/${shopId}/webhooks.json`;
    const headers = {
        Authorization: `Bearer ${env.PRINTIFY_API_TOKEN}`,
        "Content-Type": "application/json",
    };
    const readInventory = () => requestJson(request, collectionUrl, { headers, method: "GET" }, "inventory read").pipe(Effect.flatMap(decodeWebhookList));
    return Effect.runPromise(Effect.gen(function* () {
        const before = yield* readInventory();
        const plan = planDesired(before);
        if (env.PRINTIFY_WEBHOOK_OPERATION === "plan") {
            return { applicationMutations: false, plan };
        }
        for (const item of plan) {
            const url = item.action === "create"
                ? collectionUrl
                : `${PRINTIFY_ORIGIN}/v1/shops/${shopId}/webhooks/${item.id}.json`;
            const body = item.action === "create"
                ? { secret: env.PRINTIFY_WEBHOOK_SECRET, topic: item.topic, url: item.url }
                : { secret: env.PRINTIFY_WEBHOOK_SECRET, url: item.url };
            const written = yield* requestJson(request, url, { body: JSON.stringify(body), headers, method: item.action === "create" ? "POST" : "PUT" }, `${item.topic} ${item.action}`).pipe(Effect.flatMap(decodeWebhook));
            if (written.topic !== item.topic ||
                String(written.shop_id) !== shopId ||
                written.url !== WEBHOOK_URL) {
                return yield* Effect.fail(stopped(`${item.topic} write acknowledgement differed.`));
            }
        }
        const subscriptions = verifiedDesired(yield* readInventory(), shopId);
        return {
            applicationMutations: true,
            configured: true,
            secretExposed: false,
            subscriptions,
        };
    }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await configurePrintifyWebhooks()));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : "Printify webhook configuration failed.");
        process.exitCode = 1;
    }
}
