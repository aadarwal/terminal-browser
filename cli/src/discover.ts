import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface BrowserKind {
  id: string;
  name: string;
  roots: string[];
}

export interface Discovered {
  browser: string;
  name: string;
  root: string;
  port: number;
  socketPath: string;
}

export function endpointUrl(found: Discovered): string {
  return `ws://127.0.0.1:${found.port}${found.socketPath}`;
}

const HOME = os.homedir();

function macRoot(...parts: string[]): string {
  return path.join(HOME, "Library", "Application Support", ...parts);
}

function linuxRoot(...parts: string[]): string {
  const config = process.env.XDG_CONFIG_HOME;
  return path.join(config && path.isAbsolute(config) ? config : path.join(HOME, ".config"), ...parts);
}

/** where each browser keeps the profile it is running from, which is where it writes its port */
export function browserKinds(platform: NodeJS.Platform = process.platform): BrowserKind[] {
  const mac = platform === "darwin";
  const of = (macParts: string[], linuxParts: string[]) =>
    mac ? [macRoot(...macParts)] : [linuxRoot(...linuxParts)];
  return [
    { id: "helium", name: "Helium", roots: of(["net.imput.helium"], ["helium"]) },
    { id: "chrome", name: "Chrome", roots: of(["Google", "Chrome"], ["google-chrome"]) },
    { id: "chromium", name: "Chromium", roots: of(["Chromium"], ["chromium"]) },
    {
      id: "brave",
      name: "Brave",
      roots: of(["BraveSoftware", "Brave-Browser"], ["BraveSoftware", "Brave-Browser"]),
    },
    { id: "edge", name: "Edge", roots: of(["Microsoft Edge"], ["microsoft-edge"]) },
  ];
}

export function browserNames(platform?: NodeJS.Platform): string[] {
  return browserKinds(platform).map((kind) => kind.id);
}

const PORT_FILE = "DevToolsActivePort";

/**
 * A browser with debugging on writes its port and the exact websocket path it will answer on.
 * We only ever read this one file out of a profile.
 */
export function readActivePort(root: string): { port: number; socketPath: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const [first, second] = text.split("\n");
  const port = Number((first ?? "").trim());
  const socketPath = (second ?? "").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(socketPath)) return null;
  return { port, socketPath };
}

/** a port that answers is a browser still running, a port that refuses is a leftover file */
export function reachable(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export interface DiscoverOptions {
  kinds?: BrowserKind[];
  live?: (port: number) => Promise<boolean>;
}

export async function discoverBrowsers(options: DiscoverOptions = {}): Promise<Discovered[]> {
  const kinds = options.kinds ?? browserKinds();
  const live = options.live ?? reachable;
  const candidates: Discovered[] = [];
  for (const kind of kinds) {
    for (const root of kind.roots) {
      const active = readActivePort(root);
      if (!active) continue;
      candidates.push({ browser: kind.id, name: kind.name, root, ...active });
    }
  }
  const answers = await Promise.all(candidates.map((found) => live(found.port)));
  return candidates.filter((_, at) => answers[at]);
}

export async function discoverIn(
  root: string,
  options: DiscoverOptions = {},
): Promise<Discovered | null> {
  const found = await discoverBrowsers({
    ...options,
    kinds: [{ id: "profile", name: path.basename(root), roots: [root] }],
  });
  return found[0] ?? null;
}
