import assert from "node:assert/strict";
import { createClerkClient } from "@clerk/backend";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* Environment can be provided by the deployment runner. */
}
const origin = process.env.GUIDE_TEST_URL || "http://localhost:3015";
const assetStatus = process.env.GUIDE_TEST_PRIVATE_ASSETS === "1" ? 200 : 503;
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const unauth = await fetch(origin, {
  redirect: "manual",
  headers: { Accept: "text/html" },
});
assert.ok(
  [302, 307].includes(unauth.status),
  "Guide must redirect signed-out visitors",
);
assert.ok(
  !(await unauth.text()).includes("host@example.invalid"),
  "No private content while signed out",
);
assert.equal((await fetch(`${origin}/api/wifi`)).status, 401);
assert.equal((await fetch(`${origin}/api/guide`)).status, 401);
for (const photo of ["kitchen-cupboards", "laundry", "linen-cupboard"])
  assert.equal((await fetch(`${origin}/photos/${photo}`)).status, 401);
assert.equal(
  (
    await fetch(`${origin}/api/guide`, {
      method: "PUT",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    })
  ).status,
  401,
);
const closedApi = await fetch(`${origin}/api/chat`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(
  (await fetch(`${origin}/api/home`)).status,
  401,
  "Controls must require sign-in",
);
assert.equal(
  (
    await fetch(`${origin}/api/home`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    })
  ).status,
  401,
);
for (const route of [
  "/building",
  "/building?task=recycling&step=3",
  "/parking",
  "/parking/plan.svg",
  "/building/evacuation",
])
  assert.equal(
    (await fetch(`${origin}${route}`, { redirect: "manual" })).status,
    404,
    `Removed map route must not serve the old guide: ${route}`,
  );
const closedEvacuation = await fetch(`${origin}/evacuation`, {
  redirect: "manual",
});
assert.equal(
  closedEvacuation.status,
  401,
  "Evacuation photo must require sign-in",
);
assert.ok(
  [401, 403, 404].includes(closedApi.status),
  "Chat must require sign-in",
);
console.log("PASS: signed-out guide and chat protection");
if (process.env.GUIDE_TEST_URL) process.exit(0);
assert.ok(
  process.env.CLERK_SECRET_KEY?.startsWith("sk_test_"),
  "Authenticated smoke tests run only on development Clerk",
);
const owners = await client.users.getUserList({
  emailAddress: [process.env.OWNER_EMAIL],
});
const owner = owners.data[0];
assert.ok(owner, "Development host must exist");
const ownerSession = await client.sessions.createSession({ userId: owner.id });
const ownerToken = await client.sessions.getToken(ownerSession.id);
const headers = {
  Authorization: `Bearer ${ownerToken.jwt}`,
  Origin: origin,
  "Content-Type": "application/json",
};
let guest;
let guestSession;
try {
  const guide = await fetch(origin, { headers });
  assert.equal(guide.status, 200);
  const html = await guide.text();
  const cmsResponse = await fetch(`${origin}/api/guide`, { headers });
  assert.equal(cmsResponse.status, 200);
  const document = (await cmsResponse.json()).state.published;
  assert.ok(
    html.includes(document.home.hostEmail),
    "Published host contact is rendered",
  );
  assert.equal((await fetch(`${origin}/guests`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/edit`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/guide`, { headers })).status, 200);
  assert.ok(
    !html.includes("AI-only fixture note"),
    "Chat-only facts are not serialized into the visible guide",
  );
  assert.ok(
    !html.includes("AI-only fixture note"),
    "Unavailable items are not in guest cards",
  );
  for (const photo of ["kitchen-cupboards", "laundry", "linen-cupboard"]) {
    const response = await fetch(`${origin}/photos/${photo}`, { headers });
    assert.equal(response.status, assetStatus);
    if (assetStatus !== 200) continue;
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
  }
  assert.equal(
    (await fetch(`${origin}/photos/unknown`, { headers })).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/guide`, {
        method: "PUT",
        headers: { ...headers, Origin: "https://untrusted.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${origin}/api/guide`, { method: "PUT", headers, body: "{}" }))
      .status,
    400,
  );
  for (const route of [
    "/building",
    "/building?task=arrive",
    "/parking",
    "/parking/plan.svg",
  ])
    assert.equal(
      (await fetch(`${origin}${route}`, { headers })).status,
      404,
      `Authenticated visitors cannot reach removed maps: ${route}`,
    );
  assert.ok(
    !html.includes("/building?task="),
    "No nested journey links in the guide",
  );
  const evacuation = await fetch(`${origin}/evacuation`, { headers });
  assert.equal(evacuation.status, assetStatus);
  if (assetStatus === 200) {
    assert.equal(evacuation.headers.get("content-type"), "image/jpeg");
    assert.equal(evacuation.headers.get("cache-control"), "private, no-store");
    assert.ok(
      (await evacuation.arrayBuffer()).byteLength > 1000,
      "Original diagram is delivered",
    );
  }
  assert.equal(
    (
      await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: [] }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/invitations`, {
        method: "POST",
        headers: { ...headers, Origin: "https://untrusted.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  guest = await client.users.createUser({
    emailAddress: [`guest+clerk_test_${Date.now()}@example.com`],
    skipPasswordRequirement: true,
    publicMetadata: { guideAccess: "guest" },
  });
  guestSession = await client.sessions.createSession({ userId: guest.id });
  const guestToken = await client.sessions.getToken(guestSession.id);
  const guestHeaders = {
    ...headers,
    Authorization: `Bearer ${guestToken.jwt}`,
  };
  assert.equal(
    (await fetch(`${origin}/api/guide`, { headers: guestHeaders })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/guide`, {
        method: "PUT",
        headers: guestHeaders,
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${origin}/photos/laundry`, { headers: guestHeaders })).status,
    assetStatus,
  );
  assert.equal(
    (await fetch(`${origin}/api/home`, { headers: guestHeaders })).status,
    410,
  );
  for (const body of [
    "not-json",
    JSON.stringify({ type: "vacuum", action: "start" }),
    JSON.stringify({ type: "light", room: "bedroom", value: 20 }),
    "x".repeat(1025),
  ]) {
    assert.equal(
      (
        await fetch(`${origin}/api/home`, {
          method: "POST",
          headers: guestHeaders,
          body,
        })
      ).status,
      410,
    );
  }
  assert.equal(
    (
      await fetch(`${origin}/api/home`, {
        method: "POST",
        headers: { ...guestHeaders, Origin: "https://untrusted.example" },
        body: JSON.stringify({ type: "vacuum", action: "start" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/home`, {
        method: "POST",
        headers: { ...guestHeaders, "Content-Type": "text/plain" },
        body: "{}",
      })
    ).status,
    410,
  );
  const guestGuide = await fetch(origin, { headers: guestHeaders });
  assert.equal(guestGuide.status, 200);
  const guestHtml = await guestGuide.text();
  assert.ok(
    guestHtml.includes(document.home.hostPhone),
    "Guest can find host phone",
  );
  assert.ok(
    guestHtml.includes(document.home.hostEmail),
    "Guest can find host email",
  );
  assert.ok(!guestHtml.includes("details to confirm before publishing"));
  assert.equal(
    (await fetch(`${origin}/api/wifi`, { headers: guestHeaders })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/wifi`, {
        method: "POST",
        headers: guestHeaders,
        body: JSON.stringify({ password: "test-password" }),
      })
    ).status,
    403,
    "Guests cannot change the Wi-Fi password",
  );
  assert.equal(
    (
      await fetch(`${origin}/api/wifi`, {
        method: "POST",
        headers,
        body: JSON.stringify({ password: "short" }),
      })
    ).status,
    400,
    "Host password input is validated before writing",
  );
  assert.equal(
    (await fetch(`${origin}/evacuation`, { headers: guestHeaders })).status,
    assetStatus,
  );
  for (const route of ["/building", "/parking", "/parking/plan.svg"])
    assert.equal(
      (await fetch(`${origin}${route}`, { headers: guestHeaders })).status,
      404,
    );
  assert.equal(
    (await fetch(`${origin}/guests`, { headers: guestHeaders })).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/invitations`, {
        method: "POST",
        headers: guestHeaders,
        body: "{}",
      })
    ).status,
    403,
  );
  await client.users.updateUserMetadata(guest.id, {
    publicMetadata: { guideAccess: "revoked" },
  });
  assert.equal(
    (await fetch(`${origin}/api/wifi`, { headers: guestHeaders })).status,
    401,
    "Revoked guests cannot read Wi-Fi credentials",
  );
  const revoked = await fetch(origin, {
    headers: guestHeaders,
    redirect: "manual",
  });
  assert.equal(
    (await fetch(`${origin}/api/home`, { headers: guestHeaders })).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/home`, {
        method: "POST",
        headers: guestHeaders,
        body: JSON.stringify({ type: "vacuum", action: "start" }),
      })
    ).status,
    401,
  );
  assert.equal(revoked.status, 307);
  assert.ok(revoked.headers.get("location")?.endsWith("/access"));
  assert.equal(
    (await fetch(`${origin}/evacuation`, { headers: guestHeaders })).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: guestHeaders,
        body: "{}",
      })
    ).status,
    401,
  );
  console.log(
    "PASS: host and guest access, host-only administration, revoked guest denial, CSRF and chat validation",
  );
  if (process.argv.includes("--chat")) {
    const response = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [
          {
            id: "smoke",
            role: "user",
            parts: [
              {
                type: "text",
                text: "Where does recycling go? Please cite the guide.",
              },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.ok(!stream.includes('"type":"error"'), "AI provider must succeed");
    assert.ok(stream.includes("text-delta"), "AI must stream an answer");
    console.log("PASS: live AI response streamed successfully");
  }
} finally {
  if (guestSession) await client.sessions.revokeSession(guestSession.id);
  if (guest) await client.users.deleteUser(guest.id);
  await client.sessions.revokeSession(ownerSession.id);
}
