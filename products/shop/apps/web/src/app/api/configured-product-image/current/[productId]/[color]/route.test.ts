import { afterEach, expect, it, vi } from "vitest";
import { GET, HEAD } from "./route";
vi.mock("@/env",()=>({env:{FOREVER_TEE_API_URL:"https://api.test",FOREVER_TEE_API_SHARED_SECRET:"service-test"}}));
afterEach(()=>{ vi.unstubAllGlobals(); vi.useRealTimers(); });
const productId="11111111-1111-4111-8111-111111111111";
const params={productId,color:"white.webp",};
it("forwards pending readiness without adding a proxy retry loop",async()=>{
  vi.useFakeTimers();
  const send=vi.fn().mockImplementation(()=>Promise.resolve(new Response(null,{status:202,headers:{"retry-after":"2"}})));
  vi.stubGlobal("fetch",send);
  let status:number|undefined;
  const work=GET(new Request("https://shop.test/image"),{params:Promise.resolve(params)}).then(response=>{status=response.status;});
  await vi.advanceTimersByTimeAsync(1);
  expect(status).toBe(202);
  expect(send).toHaveBeenCalledTimes(1);
  await work;
});
it("serves the authoritative R2 image and forwards bounded size and revision",async()=>{
  const send=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{"content-type":"image/webp",etag:'"stored"'}}));
  vi.stubGlobal("fetch",send);
  const response=await GET(new Request("https://shop.test/image?width=384"),{params:Promise.resolve(params)});
  expect(response.status).toBe(200);expect(await response.arrayBuffer()).toEqual(new Uint8Array([1,2,3]).buffer);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBe('"stored"');
  const url: unknown=send.mock.calls[0]?.[0];expect(url).toBeInstanceOf(URL);
  expect(String(url)).toContain(`/configured-products/${productId}/images/flat/white?width=384&format=webp`);
 });
it("does not serve a stored image after access is revoked",async()=>{
  const send=vi.fn().mockResolvedValue(new Response(null,{status:404}));vi.stubGlobal("fetch",send);
  expect((await GET(new Request("https://shop.test/image"),{params:Promise.resolve(params)})).status).toBe(404);
});
it("rejects arbitrary widths before fetching",async()=>{
  const send=vi.fn();vi.stubGlobal("fetch",send);
  expect((await GET(new Request("https://shop.test/image?width=99999"),{params:Promise.resolve(params)})).status).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

it("forwards HEAD as metadata-only without issuing an upstream image GET",async()=>{
  const send=vi.fn().mockResolvedValue(new Response(null,{headers:{"content-type":"image/webp"}}));
  vi.stubGlobal("fetch",send);
  const response=await HEAD(new Request("https://shop.test/image",{method:"HEAD"}),{params:Promise.resolve(params)});
  expect(response.status).toBe(200);
  expect(send.mock.calls[0]?.[1]).toMatchObject({method:"HEAD"});
  expect(await response.text()).toBe("");
});
