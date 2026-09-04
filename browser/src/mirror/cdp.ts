import http from "node:http";

export interface CdpEndpoint {
  host: string;
  port: number;
  /**
   * The exact browser websocket, when the browser told us where to knock. Browsers that ask
   * their human for permission only publish this path, and answer no http at all.
   */
  socketUrl: string | null;
}

export const DEFAULT_MIRROR_PORT = 9222;
const HTTP_TIMEOUT_MS = 4000;
/** the human has to answer the browser's permission prompt, which takes a moment */
export const CONSENT_TIMEOUT_MS = 60_000;

const BROWSER_SOCKET_PATH = "/devtools/browser/";

export function parseEndpoint(value: string): CdpEndpoint {
  const text = value.trim();
  if (!text) throw new Error("a debugging endpoint looks like 9222 or 127.0.0.1:9222");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : /^\d+$/.test(text)
      ? `http://127.0.0.1:${text}`
      : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${value} is not a debugging endpoint (try 9222 or 127.0.0.1:9222)`);
  }
  // a browser on this machine speaks plain ws and http, so anything else is a mistake we keep
  if (url.protocol !== "ws:" && url.protocol !== "http:") {
    throw new Error(`${value} is not a debugging endpoint we can speak (ws:// or http://)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${value} carries more than a debugging endpoint should`);
  }
  const port = url.port ? Number(url.port) : url.protocol === "ws:" ? 0 : DEFAULT_MIRROR_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${value} has no usable port (1-65535)`);
  }
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  if (url.protocol === "http:") return { host, port, socketUrl: null };
  if (!url.pathname.startsWith(BROWSER_SOCKET_PATH)) {
    throw new Error(`${value} is not a browser websocket (it should end in ${BROWSER_SOCKET_PATH}<id>)`);
  }
  url.hostname = host;
  return { host, port, socketUrl: url.toString() };
}

export function socketEndpoint(host: string, port: number, path: string): CdpEndpoint {
  return parseEndpoint(`ws://${host}:${port}${path}`);
}

export function endpointOf(port: number): CdpEndpoint {
  return parseEndpoint(String(port));
}

export function httpOrigin(endpoint: CdpEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

/** how an endpoint is written down: the exact socket if we have one, the http address if not */
export function endpointLabel(endpoint: CdpEndpoint): string {
  return endpoint.socketUrl ?? httpOrigin(endpoint);
}

export interface RemoteTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

export function pickTarget(targets: RemoteTarget[], wanted: string | null): RemoteTarget {
  const pages = targets.filter((target) => target.type === "page");
  if (wanted) {
    const exact = targets.find((target) => target.id === wanted);
    if (!exact) {
      const known = pages.map((page) => `  ${page.id}  ${page.url}`).join("\n");
      throw new Error(`no tab ${wanted} in that browser${known ? `\n\ntabs:\n${known}` : ""}`);
    }
    if (exact.type !== "page") throw new Error(`${wanted} is a ${exact.type}, not a tab`);
    return exact;
  }
  const first = pages.find((page) => !page.url.startsWith("devtools://"));
  if (!first) throw new Error("that browser has no tab open to mirror");
  return first;
}

export function describeTargets(targets: RemoteTarget[]): string {
  return targets
    .filter((target) => target.type === "page")
    .map((target) => `  ${target.id}  ${target.title || target.url}\n      ${target.url}`)
    .join("\n");
}

export async function fetchJson<T>(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<T> {
  const body = await new Promise<string>((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} answered ${response.statusCode}`));
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => resolve(text));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`${url} did not answer in ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
  return JSON.parse(body) as T;
}

export function unreachable(endpoint: CdpEndpoint, error: unknown): Error {
  const why = error instanceof Error ? error.message : String(error);
  return new Error(
    `nothing is listening for debugging on ${endpointLabel(endpoint)} (${why})\n` +
      `turn debugging on at chrome://inspect/#remote-debugging, or start the browser with ` +
      `--remote-debugging-port=${endpoint.port}`,
  );
}

export async function listTargets(endpoint: CdpEndpoint): Promise<RemoteTarget[]> {
  const rows = await fetchJson<Record<string, unknown>[]>(
    `${httpOrigin(endpoint)}/json/list`,
  ).catch((error: unknown) => {
    throw unreachable(endpoint, error);
  });
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    type: String(row.type ?? ""),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
  }));
}

export async function browserSocketUrl(endpoint: CdpEndpoint): Promise<string> {
  if (endpoint.socketUrl) return endpoint.socketUrl;
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    `${httpOrigin(endpoint)}/json/version`,
  ).catch((error: unknown) => {
    throw unreachable(endpoint, error);
  });
  const url = version.webSocketDebuggerUrl;
  if (!url) throw new Error(`${httpOrigin(endpoint)} does not speak the devtools protocol`);
  // the browser answers with whatever host it was asked about, and refuses other names
  const parsed = new URL(url);
  parsed.hostname = endpoint.host;
  parsed.port = String(endpoint.port);
  return parsed.toString();
}

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
  /** false for the commands the browser itself answers, rather than the mirrored tab */
  onSession: boolean;
}

/** letting go of a mirrored tab stops the pictures and hands it back, still open */
export function detachCommands(sessionId: string): CdpCommand[] {
  return [
    { method: "Page.stopScreencast", onSession: true },
    { method: "Target.detachFromTarget", params: { sessionId }, onSession: false },
  ];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface ConnectionLease {
  connection: CdpConnection;
  release(): void;
}

interface PooledConnection {
  opening: Promise<CdpConnection>;
  refs: number;
}

const pool = new Map<string, PooledConnection>();

/**
 * One connection per browser, however many views it feeds. Browsers ask their human before
 * sharing a tab, and asking once per pane would be rude.
 */
export async function leaseConnection(
  endpoint: CdpEndpoint,
  waitMs = CONSENT_TIMEOUT_MS,
): Promise<ConnectionLease> {
  const key = endpointLabel(endpoint);
  let entry = pool.get(key);
  if (!entry) {
    entry = { opening: CdpConnection.open(endpoint, waitMs), refs: 0 };
    pool.set(key, entry);
  }
  const held = entry;
  held.refs += 1;
  let connection: CdpConnection;
  try {
    connection = await held.opening;
  } catch (error) {
    held.refs -= 1;
    drop(key, held);
    throw error;
  }
  const forget = connection.onClosed(() => {
    if (pool.get(key) === held) pool.delete(key);
  });
  let released = false;
  return {
    connection,
    release() {
      if (released) return;
      released = true;
      forget();
      held.refs -= 1;
      if (held.refs > 0) return;
      drop(key, held);
      connection.close();
    },
  };
}

function drop(key: string, entry: PooledConnection): void {
  if (pool.get(key) === entry && entry.refs <= 0) pool.delete(key);
}

interface CdpReply {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

type EventHandler = (params: unknown) => void;

type BrowserSocket = InstanceType<typeof http.WebSocket>;

function openSocket(url: string, timeoutMs: number): Promise<BrowserSocket> {
  return new Promise((resolve, reject) => {
    const socket = new http.WebSocket(url);
    let answered = false;
    const onOpen = () => settle(null);
    const onError = () => settle(new Error(`the browser turned down the debugging connection to ${url}`));
    // a browser that is asked and refused hangs up without ever answering the handshake
    const onClose = () =>
      settle(new Error(`the browser hung up on ${url} before letting us in, so it was turned down`));
    const settle = (error: Error | null) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (!error) {
        resolve(socket);
        return;
      }
      try {
        socket.close();
      } catch {}
      reject(error);
    };
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `the browser did not let us in within ${Math.round(timeoutMs / 1000)}s — ` +
              "it asks before sharing a tab, so look for its permission prompt",
          ),
        ),
      timeoutMs,
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

/** one browser-level connection; pages hang off it as flat sessions */
export class CdpConnection {
  private readonly socket: BrowserSocket;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private seq = 0;
  private closed = false;
  private readonly closeHandlers = new Set<(error: Error) => void>();

  private constructor(socket: BrowserSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.finish());
    socket.addEventListener("error", () => this.finish());
  }

  static async open(endpoint: CdpEndpoint, waitMs = CONSENT_TIMEOUT_MS): Promise<CdpConnection> {
    const url = await browserSocketUrl(endpoint);
    const socket = await openSocket(url, waitMs).catch((error: unknown) => {
      throw endpoint.socketUrl ? asError(error) : unreachable(endpoint, error);
    });
    return new CdpConnection(socket);
  }

  /** several views can share one connection, so each of them listens for the end of it */
  onClosed(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const gone = new Error("the browser closed the debugging connection");
    for (const waiter of this.pending.values()) waiter.reject(gone);
    this.pending.clear();
    for (const handler of [...this.closeHandlers]) handler(gone);
    this.closeHandlers.clear();
  }

  /** the tabs the browser has open, asked for over this connection rather than over http */
  async targets(): Promise<RemoteTarget[]> {
    const reply = (await this.send("Target.getTargets")) as {
      targetInfos?: { targetId?: string; type?: string; title?: string; url?: string }[];
    };
    return (reply.targetInfos ?? []).map((info) => ({
      id: String(info.targetId ?? ""),
      type: String(info.type ?? ""),
      title: String(info.title ?? ""),
      url: String(info.url ?? ""),
    }));
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("the debugging connection is closed"));
    const id = ++this.seq;
    const message: Record<string, unknown> = { id, method };
    if (params) message.params = params;
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }

  /** events are keyed by session so two mirrors on one browser never see each other's pages */
  on(sessionId: string | null, method: string, handler: EventHandler | null): void {
    const key = `${sessionId ?? ""}:${method}`;
    if (!handler) {
      this.handlers.delete(key);
      return;
    }
    const existing = this.handlers.get(key);
    if (existing) existing.add(handler);
    else this.handlers.set(key, new Set([handler]));
  }

  off(sessionId: string | null, method: string, handler: EventHandler): void {
    const key = `${sessionId ?? ""}:${method}`;
    const existing = this.handlers.get(key);
    if (!existing) return;
    existing.delete(handler);
    if (existing.size === 0) this.handlers.delete(key);
  }

  close(): void {
    this.closed = true;
    this.closeHandlers.clear();
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("the debugging connection is closed"));
    }
    this.pending.clear();
    try {
      this.socket.close();
    } catch {}
  }

  private receive(text: string): void {
    let reply: CdpReply;
    try {
      reply = JSON.parse(text) as CdpReply;
    } catch {
      return;
    }
    if (typeof reply.id === "number") {
      const waiter = this.pending.get(reply.id);
      if (!waiter) return;
      this.pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error.message ?? "devtools protocol error"));
      else waiter.resolve(reply.result ?? {});
      return;
    }
    if (!reply.method) return;
    const handlers = this.handlers.get(`${reply.sessionId ?? ""}:${reply.method}`);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(reply.params);
  }
}
