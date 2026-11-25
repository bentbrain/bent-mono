import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import postgres from "postgres";
import { commitCutProxy, openUpstream, upstreamTls } from "./commit-cut-proxy";

const base = "postgres://synthetic@127.0.0.1:5432/fitness_test";
const modes = ["require", "allow", "prefer", "verify-ca", "verify-full"];

describe("the proxy's TLS settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "fitness-proxy-ca-"));
  const caFile = join(dir, "ca.pem");
  writeFileSync(caFile, "synthetic CA\n");
  // The driver reads PGSSL from the environment; these checks start from
  // an environment without it or PGSSLMODE.
  const saved = { PGSSL: process.env.PGSSL, PGSSLMODE: process.env.PGSSLMODE };
  beforeAll(() => {
    delete process.env.PGSSL;
    delete process.env.PGSSLMODE;
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved))
      if (value !== undefined) process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  const plan = (query: string, env: Record<string, string> = {}) =>
    upstreamTls(new URL(`${base}${query}`), env);

  test("use TLS when the driver would", () => {
    for (const query of ["", "?sslmode=disable", "?ssl=false"])
      expect(plan(query).secure).toBe(false);
    for (const mode of modes) {
      const found = plan(`?sslmode=${mode}`);
      expect(found.secure).toBe(true);
      expect(found.plaintextFallback).toBe(
        mode === "prefer" || mode === "allow",
      );
    }
    // The driver reads sslrootcert=system as verify-full.
    expect(plan("?sslrootcert=system").secure).toBe(true);
    const direct = plan("?sslmode=require&sslnegotiation=direct");
    expect(direct.direct).toBe(true);
    expect(direct.tls.ALPNProtocols).toEqual(["postgresql"]);
  });

  test("verify the certificate and host name in every mode", () => {
    for (const mode of modes) {
      const { tls } = plan(`?sslmode=${mode}`);
      expect("rejectUnauthorized" in tls).toBe(false);
      expect("checkServerIdentity" in tls).toBe(false);
      expect(tls.ca).toBeUndefined();
    }
    // An IP address sends no server name; a host name does.
    expect(plan("?sslmode=require").tls.servername).toBeUndefined();
    expect(
      upstreamTls(
        new URL("postgres://synthetic@db.invalid/x?sslmode=require"),
        {},
      ).tls.servername,
    ).toBe("db.invalid");
  });

  test("trust the CA that sslrootcert or PGSSLROOTCERT names", () => {
    const named = plan(`?sslmode=require&sslrootcert=${caFile}`);
    expect(String(named.tls.ca)).toBe("synthetic CA\n");
    const fromEnv = plan("?sslmode=require", { PGSSLROOTCERT: caFile });
    expect(String(fromEnv.tls.ca)).toBe("synthetic CA\n");
    // `system` keeps Node's own roots.
    expect(plan("?sslrootcert=system").tls.ca).toBeUndefined();
  });
});

/** Runs openssl, which the test needs to make a CA and certificates. */
function openssl(dir: string, ...args: string[]) {
  const run = Bun.spawnSync(["openssl", ...args], { cwd: dir });
  if (run.exitCode !== 0)
    throw new Error(`openssl ${args[0]} failed: ${run.stderr.toString()}`);
}

describe("the proxy's TLS verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "fitness-proxy-tls-"));
  const certs = { key: "", matching: "", mismatched: "" };
  const caFile = join(dir, "ca.pem");
  const servers: Server[] = [];
  // The live checks name their CA in the URL alone.
  const savedRootcert = process.env.PGSSLROOTCERT;
  beforeAll(() => {
    delete process.env.PGSSLROOTCERT;
    openssl(
      dir,
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes"],
      ...["-keyout", "ca.key", "-out", "ca.pem", "-days", "1"],
      ...["-subj", "/CN=Synthetic Test CA"],
      ...["-addext", "basicConstraints=critical,CA:TRUE"],
      ...["-addext", "keyUsage=critical,keyCertSign"],
    );
    openssl(
      dir,
      ...["req", "-newkey", "rsa:2048", "-nodes"],
      ...["-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=leaf"],
    );
    // The driver sends no server name for an IP address, so Node checks
    // the certificate against the socket's address.
    for (const [name, san] of [
      ["matching", "IP:127.0.0.1"],
      ["mismatched", "DNS:db.invalid"],
    ] as const) {
      writeFileSync(join(dir, `${name}.cnf`), `subjectAltName=${san}\n`);
      openssl(
        dir,
        ...["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem"],
        ...["-CAkey", "ca.key", "-CAcreateserial", "-days", "1"],
        ...["-out", `${name}.pem`, "-extfile", `${name}.cnf`],
      );
    }
    certs.key = readFileSync(join(dir, "leaf.key"), "utf8");
    certs.matching = readFileSync(join(dir, "matching.pem"), "utf8");
    certs.mismatched = readFileSync(join(dir, "mismatched.pem"), "utf8");
  });
  afterAll(() => {
    if (savedRootcert !== undefined) process.env.PGSSLROOTCERT = savedRootcert;
    for (const server of servers) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A loopback peer that accepts the SSL request, then TLS with `cert`. */
  async function tlsPeer(cert: string) {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        socket.write("S");
        const secure = new TLSSocket(socket, {
          isServer: true,
          key: certs.key,
          cert,
        });
        secure.on("error", () => undefined);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  }
  async function reach(port: number, query: string) {
    const sockets: Socket[] = [];
    try {
      await openUpstream(
        new URL(`postgres://synthetic@127.0.0.1:${port}/x${query}`),
        (s) => sockets.push(s),
        2000,
      );
      return "connected";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }

  test("refuses a certificate for another host in every mode", async () => {
    const mismatched = await tlsPeer(certs.mismatched);
    for (const mode of modes)
      expect(
        await reach(mismatched, `?sslmode=${mode}&sslrootcert=${caFile}`),
      ).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  test("accepts a certificate for the host from the sslrootcert CA", async () => {
    const matching = await tlsPeer(certs.matching);
    for (const mode of modes)
      expect(
        await reach(matching, `?sslmode=${mode}&sslrootcert=${caFile}`),
      ).toBe("connected");
  });

  test("refuses a certificate from a CA it does not trust", async () => {
    const matching = await tlsPeer(certs.matching);
    for (const query of [
      "?sslmode=require",
      "?sslmode=prefer",
      "?sslrootcert=system",
    ])
      expect(await reach(matching, query)).toBe(
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      );
  });
});

describe("the proxy's client URL", () => {
  test("stays plaintext whatever PGSSL says", async () => {
    const proxy = await commitCutProxy(new URL(`${base}?sslmode=require`));
    const saved = process.env.PGSSL;
    process.env.PGSSL = "require";
    try {
      expect(new URL(proxy.url).searchParams.get("sslmode")).toBe("disable");
      expect(postgres(proxy.url).options.ssl).toBe(false);
      // A client's own option still wins, as the encryption test uses.
      expect(postgres(proxy.url, { ssl: "prefer" }).options.ssl).toBe("prefer");
    } finally {
      if (saved === undefined) delete process.env.PGSSL;
      else process.env.PGSSL = saved;
      await proxy.close();
    }
  });
});

describe("the proxy's sockets", () => {
  /** A loopback peer that accepts TCP and never answers. */
  async function silentPeer() {
    const accepted: Socket[] = [];
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      // Reading lets the peer see the proxy close its side.
      socket.resume();
      accepted.push(socket);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, accepted, port };
  }
  /** Connects to the proxy and sends a startup message. */
  async function startClient(url: string) {
    const target = new URL(url);
    const client = connect(Number(target.port), target.hostname);
    client.on("error", () => undefined);
    client.resume();
    await new Promise<void>((resolve) => client.once("connect", resolve));
    const body = Buffer.from("user\0synthetic\0\0");
    const startup = Buffer.alloc(8);
    startup.writeInt32BE(8 + body.length, 0);
    startup.writeInt32BE(196608, 4);
    client.write(Buffer.concat([startup, body]));
    return client;
  }
  const closed = (socket: Socket) =>
    socket.destroyed
      ? Promise.resolve()
      : new Promise<void>((resolve) => socket.once("close", () => resolve()));
  async function waitFor(check: () => boolean) {
    for (let n = 0; n < 200 && !check(); n++) await Bun.sleep(10);
    expect(check()).toBe(true);
  }

  test("closes a connection whose SSL reply never comes", async () => {
    const peer = await silentPeer();
    const proxy = await commitCutProxy(
      new URL(`postgres://synthetic@127.0.0.1:${peer.port}/x?sslmode=require`),
    );
    try {
      const client = await startClient(proxy.url);
      await waitFor(() => peer.accepted.length === 1);
      await proxy.close();
      await Promise.all([closed(client), ...peer.accepted.map(closed)]);
      expect(proxy.openSockets).toBe(0);
    } finally {
      peer.server.close();
    }
  });

  test("gives up on an SSL reply after the negotiation timeout", async () => {
    const peer = await silentPeer();
    const proxy = await commitCutProxy(
      new URL(`postgres://synthetic@127.0.0.1:${peer.port}/x?sslmode=require`),
      { negotiationMs: 200 },
    );
    try {
      const client = await startClient(proxy.url);
      await Promise.all([
        closed(client),
        (async () => {
          await waitFor(() => peer.accepted.length === 1);
          await Promise.all(peer.accepted.map(closed));
        })(),
      ]);
      await waitFor(() => proxy.openSockets === 0);
    } finally {
      await proxy.close();
      peer.server.close();
    }
  });
});
