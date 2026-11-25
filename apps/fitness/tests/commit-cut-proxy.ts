/**
 * A proxy to a test database that forwards whole PostgreSQL protocol
 * messages. Once armed, it forwards the next COMMIT in full, then closes
 * the client's side of that connection only, so Postgres goes on
 * committing and the client never sees the reply.
 *
 * The client's side is plaintext on loopback: the proxy answers an SSL or
 * GSS encryption request with `N`, and the client carries on in plaintext.
 * The proxy reaches the database with TLS when postgres.js would use it
 * for the same URL, so it still reads every message, COMMIT included.
 */
import { readFileSync } from "node:fs";
import { connect, createServer, isIP } from "node:net";
import type { Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { ConnectionOptions } from "node:tls";
import postgres from "postgres";

const sslRequestCode = 80877103;
const gssRequestCode = 80877104;
const commit = /^\s*commit\s*;?\s*$/i;

/**
 * How the proxy reaches the database at this URL: its host and port,
 * whether it uses TLS, whether it negotiates TLS directly, and the TLS
 * options it passes to Node. postgres.js's own parser reads the URL and
 * environment, so the proxy uses TLS exactly when the driver would.
 *
 * The proxy always verifies the database's certificate and host name with
 * Node's defaults. That is stricter than postgres.js, which skips
 * verification for `require`, `allow` and `prefer`. A TLS test database
 * must present a certificate valid for its host, or name its CA: a file in
 * the URL's `sslrootcert`, or in `PGSSLROOTCERT`, libpq's form of it, which
 * suits a test database URL that the driver also reads. `system` uses
 * Node's own roots.
 */
export function upstreamTls(target: URL, env = process.env) {
  const { options } = postgres(target.href);
  const host = options.host[0] ?? "localhost";
  const port = options.port[0] ?? 5432;
  const ssl = options.ssl;
  const direct =
    "sslnegotiation" in options && options.sslnegotiation === "direct";
  const tls: ConnectionOptions = {
    servername: isIP(host) ? undefined : host,
  };
  if (direct) tls.ALPNProtocols = ["postgresql"];
  const rootcert =
    target.searchParams.get("sslrootcert") ?? env.PGSSLROOTCERT ?? null;
  if (rootcert && rootcert !== "system") tls.ca = readFileSync(rootcert);
  return {
    host,
    port,
    secure: Boolean(ssl),
    direct,
    prefer: ssl === "prefer",
    tls,
  };
}

/** Rejects once `ms` pass, unless `work` settles first. */
function within<T>(work: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out.`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Opens the proxy's own connection to the database, with TLS when the
 * driver would use it. Each socket goes to `track` as soon as it exists,
 * so a close during negotiation can destroy it. Negotiation that takes
 * longer than `ms` fails.
 */
export async function openUpstream(
  target: URL,
  track: (socket: Socket) => void,
  ms: number,
): Promise<Socket> {
  const plan = upstreamTls(target);
  const socket = connect(plan.port, plan.host);
  track(socket);
  socket.on("error", () => undefined);
  const negotiate = async () => {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    if (!plan.secure) return socket;
    if (!plan.direct) {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(sslRequestCode, 4);
      socket.write(request);
      const answer = await new Promise<Buffer>((resolve, reject) => {
        const closed = () => reject(new Error("The database closed."));
        socket.once("close", closed);
        socket.once("data", (data: Buffer) => {
          socket.off("close", closed);
          resolve(data);
        });
      });
      // The driver goes on in plaintext only for `prefer`; otherwise it
      // starts TLS whatever the answer, and the handshake fails.
      if (answer[0] !== 0x53 && plan.prefer) return socket;
    }
    const secure = connectTls({ ...plan.tls, socket });
    track(secure);
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    secure.on("error", () => undefined);
    return secure;
  };
  return within(negotiate(), ms, "Connecting to the database").catch(
    (error: unknown) => {
      socket.destroy();
      throw error;
    },
  );
}

/** The text of the null-terminated string at `start`, and the offset after it. */
function cstring(message: Buffer, start: number) {
  const end = message.indexOf(0, start);
  return { text: message.toString("utf8", start, end), next: end + 1 };
}

export async function commitCutProxy(
  target: URL,
  { negotiationMs = 5000 }: { negotiationMs?: number } = {},
) {
  const sockets = new Set<Socket>();
  const state = { armed: false, cuts: 0, refusedEncryption: 0, closed: false };
  const track = (socket: Socket) => {
    if (state.closed) socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    track(client);
    client.on("error", () => undefined);
    let upstream: Socket | undefined;
    const queued: Buffer[] = [];
    const forward = (message: Buffer) => {
      if (upstream) upstream.write(message);
      else queued.push(message);
    };
    let pending = Buffer.alloc(0);
    // The startup message, and an encryption request before it, have no
    // type byte; every later message has one, then an int32 length that
    // counts itself.
    let startup = true;
    // A COMMIT sent with the extended protocol runs at the next Sync.
    let commitAtSync = false;
    let cut = false;
    const open = () =>
      openUpstream(target, track, negotiationMs).then(
        (socket) => {
          if (client.destroyed || state.closed) {
            socket.destroy();
            return;
          }
          upstream = socket;
          for (const message of queued.splice(0)) socket.write(message);
          socket.on("data", (chunk: Buffer) => {
            if (!client.destroyed) client.write(chunk);
          });
          socket.on("close", () => client.destroy());
        },
        () => client.destroy(),
      );
    client.on("data", (chunk: Buffer) => {
      if (cut) return;
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < (startup ? 4 : 5)) return;
        const size = startup
          ? pending.readInt32BE(0)
          : 1 + pending.readInt32BE(1);
        if (pending.length < size) return;
        const message = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (startup) {
          const code = message.readInt32BE(4);
          if (code === sslRequestCode || code === gssRequestCode) {
            state.refusedEncryption += 1;
            client.write("N");
            continue;
          }
          startup = false;
          void open();
          forward(message);
          continue;
        }
        forward(message);
        const type = String.fromCharCode(message[0] ?? 0);
        let atCommit = false;
        if (state.armed && type === "Q")
          atCommit = commit.test(cstring(message, 5).text);
        else if (state.armed && type === "P") {
          const name = cstring(message, 5);
          commitAtSync = commit.test(cstring(message, name.next).text);
        } else if (commitAtSync && type === "S") atCommit = true;
        if (!atCommit) continue;
        state.armed = false;
        commitAtSync = false;
        state.cuts += 1;
        cut = true;
        client.destroy();
        return;
      }
    });
    // After a cut, the database's side stays open so the commit runs on.
    client.on("close", () => {
      if (!cut) upstream?.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const url = new URL(target.href);
  url.hostname = "127.0.0.1";
  url.port = String(typeof address === "object" && address ? address.port : 0);
  for (const name of ["ssl", "sslrootcert", "sslnegotiation"])
    url.searchParams.delete(name);
  // The hop to the proxy is plaintext, whatever PGSSL in the environment
  // says; a client's own `ssl` option still overrides the URL.
  url.searchParams.set("sslmode", "disable");
  return {
    /** The plaintext URL for clients of the proxy. */
    url: url.href,
    /** Cuts the client's side after the next COMMIT. */
    arm() {
      state.armed = true;
    },
    get cuts() {
      return state.cuts;
    },
    /** Encryption requests from clients that the proxy answered with `N`. */
    get refusedEncryption() {
      return state.refusedEncryption;
    },
    /** Sockets still open, including ones still negotiating. */
    get openSockets() {
      return sockets.size;
    },
    /** Destroys every socket, including ones still negotiating, and stops listening. */
    async close() {
      state.closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
