import http from "node:http";

export interface CdpEndpoint {
  host: string;
  port: number;
  origin: string;
}

export const DEFAULT_MIRROR_PORT = 9222;
const CONNECT_TIMEOUT_MS = 4000;

export function parseEndpoint(value: string): CdpEndpoint {
  const text = value.trim();
  if (!text) throw new Error("a debugging endpoint looks like 9222 or 127.0.0.1:9222");
  const withScheme = /^https?:\/\//.test(text)
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
  const port = url.port ? Number(url.port) : DEFAULT_MIRROR_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${value} has no usable port (1-65535)`);
  }
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  return { host, port, origin: `http://${host}:${port}` };
}

export function endpointOf(port: number): CdpEndpoint {
  return parseEndpoint(String(port));
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

export async function fetchJson<T>(url: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<T> {
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
    `nothing is listening for debugging on ${endpoint.origin} (${why})\n` +
      `start your browser with --remote-debugging-port=${endpoint.port}`,
  );
}

export async function listTargets(endpoint: CdpEndpoint): Promise<RemoteTarget[]> {
  const rows = await fetchJson<Record<string, unknown>[]>(`${endpoint.origin}/json/list`).catch(
    (error: unknown) => {
      throw unreachable(endpoint, error);
    },
  );
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    type: String(row.type ?? ""),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
  }));
}

export async function browserSocketUrl(endpoint: CdpEndpoint): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    `${endpoint.origin}/json/version`,
  ).catch((error: unknown) => {
    throw unreachable(endpoint, error);
  });
  const url = version.webSocketDebuggerUrl;
  if (!url) throw new Error(`${endpoint.origin} does not speak the devtools protocol`);
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
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out connecting to ${url}`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`could not open a debugging connection to ${url}`));
      },
      { once: true },
    );
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
  onClose: ((error: Error) => void) | null = null;

  private constructor(socket: BrowserSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.finish());
    socket.addEventListener("error", () => this.finish());
  }

  static async open(endpoint: CdpEndpoint): Promise<CdpConnection> {
    const url = await browserSocketUrl(endpoint);
    const socket = await openSocket(url, CONNECT_TIMEOUT_MS).catch((error: unknown) => {
      throw unreachable(endpoint, error);
    });
    return new CdpConnection(socket);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const gone = new Error("the browser closed the debugging connection");
    for (const waiter of this.pending.values()) waiter.reject(gone);
    this.pending.clear();
    this.onClose?.(gone);
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
    this.onClose = null;
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
