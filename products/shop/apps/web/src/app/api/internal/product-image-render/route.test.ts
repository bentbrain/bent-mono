import type * as Renderer from "@forever-tee/product-image-renderer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("@/env", () => ({
  env: {
    FOREVER_TEE_API_SHARED_SECRET: "service-secret",
    FOREVER_TEE_API_URL: "https://api.test",
  },
}));
vi.mock("@forever-tee/product-image-renderer", async (importOriginal) => {
  const original = await importOriginal<typeof Renderer>();
  return { ...original, renderProductDisplay: render };
});
import { GET, POST } from "./route";
const jobId = "11111111-1111-1111-1111-111111111111";
const key = `designs/${jobId}/product-images/v5/${jobId}/${jobId}/white-flat.webp`;
const recipe = {
  storageKey: key,
  baseProductSlug: "staple-tee",
  color: "White",
  view: "flat",
  printMode: "base-image-only",
  settings: {
    cropX: 0.5,
    cropY: 0.5,
    cropZoom: 1,
    depth: 0,
    placementX: 0.4,
    placementY: 0.4,
    placementWidth: 0.2,
  },
};
const source = Buffer.from("source"),
  image = Buffer.from("RIFF0000WEBPtest"),
  hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
function request(
  body = JSON.stringify({
    jobId,
    grant: "signed.grant",
    rendererVersion: "product-images-v5",
  }),
  secret = "service-secret",
) {
  return new Request("https://shop.test/api/internal/product-image-render", {
    method: "POST",
    headers: { "x-forever-tee-service-secret": secret },
    body,
  });
}
beforeEach(() => {
  render.mockReset();
  render.mockResolvedValue(image);
});
afterEach(() => vi.unstubAllGlobals());
it("authenticates before parsing or fetching and rejects malformed jobs", async () => {
  const send = vi.fn();
  vi.stubGlobal("fetch", send);
  expect(GET(new Request("https://shop.test")).status).toBe(401);
  expect((await POST(request("{}", "wrong"))).status).toBe(401);
  expect((await POST(request("invalid"))).status).toBe(400);
  expect((await POST(request("x".repeat(2049)))).status).toBe(413);
  expect(send).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});
it("a duplicate invocation cannot read artwork or render", async () => {
  const send = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal("fetch", send);
  expect((await POST(request())).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
  expect(render).not.toHaveBeenCalled();
});
it.each(["valid", "legacy-claim", "missing-source", "bad-source", "bad-publication"])(
  "requires verified artwork and R2 publication: %s",
  async (mode) => {
    const executions: string[] = [];
    const send = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString(),
        headers = new Headers(init?.headers);
      executions.push(headers.get("x-image-execution-id") ?? "");
      if (url.endsWith("/claim") && mode === "missing-source") return Promise.resolve(new Response(null, {status:404}));
      if (url.endsWith("/claim") && mode === "legacy-claim") return Promise.resolve(Response.json(recipe, {status:201}));
      if (url.endsWith("/claim") || url.endsWith("/artwork"))
        return Promise.resolve(
          new Response(source, {
            status: 201,
            headers: {
              "x-image-recipe": JSON.stringify(recipe),
              "x-image-source-sha256":
                mode === "bad-source" ? "0".repeat(64) : hash(source),
            },
          }),
        );
      if (url.endsWith("/failure"))
        return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(
        Response.json({
          key,
          sha256: mode === "bad-publication" ? "0".repeat(64) : hash(image),
          size: image.length,
        }),
      );
    });
    vi.stubGlobal("fetch", send);
    const response = await POST(request());
    expect(response.status).toBe(["valid", "legacy-claim"].includes(mode) ? 200 : 503);
    expect(new Set(executions).size).toBe(1);
    if (["valid", "legacy-claim"].includes(mode)) {
      expect(send).toHaveBeenCalledTimes(mode === "valid" ? 2 : 3);
      expect(await response.json()).toMatchObject({
        jobId,
        key,
        sha256: hash(image),
      });
    }
    if (["bad-source", "missing-source"].includes(mode)) {
      expect(render).not.toHaveBeenCalled();
      expect(send.mock.calls.some(([url]) => (url instanceof Request ? url.url : url.toString()).endsWith("/failure"))).toBe(true);
    }
  },
);

it.each(["storage-error", "lost-ack", "truncated-ack"])("retries the same publication without rendering again: %s", async mode => {
  let publications = 0;
  const executions: string[] = [];
  const bodies: unknown[] = [];
  const send = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    executions.push(new Headers(init?.headers).get("x-image-execution-id") ?? "");
    if (url.endsWith("/claim")) return Promise.resolve(new Response(source, {status:201,headers:{"x-image-recipe":JSON.stringify(recipe),"x-image-source-sha256":hash(source)}}));
    if (url.endsWith("/failure")) return Promise.resolve(new Response(null,{status:204}));
    publications++;
    bodies.push(init?.body);
    if (publications === 1) {
      if (mode === "storage-error") return Promise.resolve(new Response(null,{status:500}));
      if (mode === "lost-ack") return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(new Response('{"key":'));
    }
    return Promise.resolve(Response.json({key,sha256:hash(image),size:image.length}));
  });
  vi.stubGlobal("fetch",send);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(publications).toBe(2);
  expect(render).toHaveBeenCalledOnce();
  expect(new Set(executions).size).toBe(1);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(send.mock.calls.some(([input]) => (input instanceof Request ? input.url : input.toString()).endsWith("/failure"))).toBe(false);
  expect(await response.json()).toMatchObject({jobId,key,sha256:hash(image)});
});

it.each([403,409,429,500])("bounds publication failure without bypassing a %s rejection",async status=>{
  let publications=0,failures=0;
  vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
    const url=input instanceof Request?input.url:input.toString();
    if(url.endsWith("/claim"))return Promise.resolve(new Response(source,{status:201,headers:{"x-image-recipe":JSON.stringify(recipe),"x-image-source-sha256":hash(source)}}));
    if(url.endsWith("/failure")){failures++;return Promise.resolve(new Response(null,{status:204}));}
    publications++;return Promise.resolve(new Response(null,{status}));
  }));
  expect((await POST(request())).status).toBe(503);
  expect(publications).toBe(status===500?3:1);
  expect(failures).toBe(1);
  expect(render).toHaveBeenCalledOnce();
});

it("stops publication retries when the original render deadline expires",async()=>{
  const controller=new AbortController();
  const timeout=vi.spyOn(AbortSignal,"timeout").mockReturnValueOnce(controller.signal);
  let publications=0;
  vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>{
    const url=input instanceof Request?input.url:input.toString();
    if(url.endsWith("/claim"))return Promise.resolve(new Response(source,{status:201,headers:{"x-image-recipe":JSON.stringify(recipe),"x-image-source-sha256":hash(source)}}));
    if(url.endsWith("/failure"))return Promise.resolve(new Response(null,{status:204}));
    publications++;controller.abort();return Promise.resolve(new Response(null,{status:500}));
  }));
  try {
    expect((await POST(request())).status).toBe(503);
    expect(publications).toBe(1);
    expect(render).toHaveBeenCalledOnce();
  } finally {timeout.mockRestore();}
});
