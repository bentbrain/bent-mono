import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "react-server"],
      });
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { createHomeBridge } = await import("./home-bridge.mjs");
const { createWifiStore } = await import("./wifi-store.mjs");
const { getHomeState, runHomeCommand } =
  await import("../src/lib/home-assistant.ts");
const { homeCommandSchema } = await import("../src/lib/home-control-types.ts");
const {
  getHomeState: readBridge,
  runHomeCommand: writeBridge,
  getWifiPassword,
  saveWifiPassword,
} = await import("../src/lib/home-control-service.ts");

for (const command of [
  { type: "light", room: "kitchen", value: 40 },
  { type: "light", room: "bedroom", value: -1 },
  { type: "light", room: "bedroom", value: 101 },
  { type: "light", room: "bedroom", value: 1.2 },
  { type: "light", room: "bedroom", value: 20, entity_id: "lock.front_door" },
  { type: "vacuum", action: "send_command" },
  { type: "vacuum", action: "start", service: "unlock" },
])
  assert.equal(homeCommandSchema.safeParse(command).success, false);

const originalFetch = globalThis.fetch;
const calls = [];
const states = new Map([
  [
    "input_number.living_room_dial_lamp_target",
    { state: "30", attributes: {} },
  ],
  ["input_number.bedroom_dial_lamp_target", { state: "0", attributes: {} }],
  [
    "vacuum.vacuum",
    {
      state: "docked",
      attributes: {
        supported_features: 8212,
        battery_level: 90,
        private_detail: "not for guests",
      },
    },
  ],
]);
process.env.HOME_ASSISTANT_URL = "http://localhost:8123";
process.env.HOME_ASSISTANT_TOKEN = "test-only-ha-token";
globalThis.fetch = async (url, options) => {
  assert.equal(options.headers.Authorization, "Bearer test-only-ha-token");
  assert.equal(options.cache, "no-store");
  assert.equal(options.redirect, "error");
  calls.push({
    path: url.pathname,
    method: options.method,
    body: options.body ? JSON.parse(options.body) : null,
  });
  if (options.method === "POST") return Response.json([]);
  const entity = states.get(url.pathname.slice("/api/states/".length));
  return entity ? Response.json(entity) : new Response(null, { status: 404 });
};
const expected = {
  lights: { livingRoom: 30, bedroom: 0 },
  vacuum: { state: "docked", battery: 90, actions: ["start", "pause", "dock"] },
};
assert.deepEqual(await getHomeState(), expected);
assert.deepEqual(
  calls.map(({ path }) => path).sort(),
  [...states.keys()].map((id) => `/api/states/${id}`).sort(),
);
for (const value of [0, 100]) {
  await runHomeCommand({ type: "light", room: "bedroom", value });
  assert.deepEqual(calls.at(-1), {
    path: "/api/services/input_number/set_value",
    method: "POST",
    body: { entity_id: "input_number.bedroom_dial_lamp_target", value },
  });
}
for (const [action, service] of [
  ["start", "start"],
  ["pause", "pause"],
  ["dock", "return_to_base"],
]) {
  await runHomeCommand({ type: "vacuum", action });
  assert.deepEqual(calls.at(-1), {
    path: `/api/services/vacuum/${service}`,
    method: "POST",
    body: { entity_id: "vacuum.vacuum" },
  });
}
states.set("vacuum.vacuum", {
  state: "unavailable",
  attributes: { supported_features: 8212 },
});
assert.deepEqual((await getHomeState()).vacuum.actions, []);
const posts = () => calls.filter((call) => call.method === "POST").length;
const before = posts();
await assert.rejects(runHomeCommand({ type: "vacuum", action: "start" }));
states.set("input_number.bedroom_dial_lamp_target", {
  state: "unavailable",
  attributes: {},
});
await assert.rejects(
  runHomeCommand({ type: "light", room: "bedroom", value: 40 }),
);
assert.equal(posts(), before, "Unavailable devices must not receive commands");
states.delete("input_number.bedroom_dial_lamp_target");
const partial = await getHomeState();
assert.equal(partial.lights.bedroom, null);
assert.equal(
  partial.lights.livingRoom,
  30,
  "One missing device must not disable another",
);
states.set("vacuum.vacuum", {
  state: "docked",
  attributes: { supported_features: 16 },
});
assert.deepEqual((await getHomeState()).vacuum.actions, ["dock"]);
await assert.rejects(runHomeCommand({ type: "vacuum", action: "pause" }));
globalThis.fetch = originalFetch;

const token = "test-bridge-token-at-least-32-characters";
let writes = 0;
let reads = 0;
let failWrite = false;
let wifi = { password: null };
const server = createHomeBridge({
  token,
  wifiRead: async () => wifi,
  wifiWrite: async (data) => {
    wifi = data;
  },
  read: async () => {
    reads++;
    return expected;
  },
  write: async () => {
    if (failWrite) throw new Error("Secret must not leak");
    writes++;
  },
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
try {
  assert.equal((await fetch(`${origin}/state`)).status, 401);
  assert.equal(
    (
      await fetch(`${origin}/state`, {
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  assert.equal(reads, 0);
  assert.equal((await fetch(`${origin}/api/states`, { headers })).status, 404);
  assert.equal(
    (await fetch(`${origin}/state?entity=lock`, { headers })).status,
    404,
  );
  const state = await fetch(`${origin}/state`, { headers });
  assert.equal(state.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await state.json(), expected);
  for (const [body, status] of [
    ["bad-json", 400],
    [JSON.stringify({ type: "vacuum", action: "unlock" }), 400],
    ["x".repeat(1025), 413],
  ]) {
    assert.equal(
      (await fetch(`${origin}/command`, { method: "POST", headers, body }))
        .status,
      status,
    );
  }
  assert.equal(writes, 0);
  process.env.HOME_CONTROL_BRIDGE_URL = origin;
  process.env.HOME_CONTROL_BRIDGE_TOKEN = token;
  assert.deepEqual(await readBridge(), expected);
  assert.deepEqual(await getWifiPassword(), { password: null });
  const wifiBad = await fetch(`${origin}/wifi`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password: "test-password", extra: true }),
  });
  assert.equal(wifiBad.status, 400);
  assert.equal((await fetch(`${origin}/wifi`)).status, 401);
  await saveWifiPassword({ password: "test-password" });
  assert.deepEqual(await getWifiPassword(), { password: "test-password" });
  await writeBridge({ type: "vacuum", action: "dock" });
  assert.equal(writes, 1);
  failWrite = true;
  const failed = await fetch(`${origin}/command`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "vacuum", action: "start" }),
  });
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes("Secret"), false);
  for (let i = reads + 2; i < 120; i++)
    assert.equal((await fetch(`${origin}/state`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/state`, { headers })).status, 429);
  process.env.VERCEL = "1";
  await assert.rejects(readBridge(), /Invalid controls URL/);
  delete process.env.VERCEL;
} finally {
  await new Promise((resolve) => server.close(resolve));
}
const temporary = await mkdtemp(join(tmpdir(), "bent-stay-wifi-test-"));
try {
  const path = `${temporary}/guest-wifi.json`;
  const store = createWifiStore(path);
  assert.deepEqual(await store.read(), { password: null });
  await assert.rejects(store.write({ password: "short" }));
  await store.write({ password: "test-only-password" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await createWifiStore(path).read(), {
    password: "test-only-password",
  });
} finally {
  await rm(temporary, { recursive: true });
}
console.log(
  "PASS: controls allowlist, real service mappings, unavailable devices, bridge authentication, bounded input, private responses, rate limits and private Wi-Fi persistence; no live device commands",
);
