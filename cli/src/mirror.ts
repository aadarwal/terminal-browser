import http from "node:http";

import { browserKinds, browserNames, discoverBrowsers, discoverIn, endpointUrl, reachable } from "./discover";
import type { Discovered, DiscoverOptions } from "./discover";

export const DEFAULT_MIRROR_PORT = 9222;

export interface MirrorRequest {
  /** set when the endpoint is already known, from --cdp, --port, or our own normalized flag */
  endpoint: string | null;
  browser: string | null;
  userDataDir: string | null;
  target: string | null;
  newTab: boolean;
}

export interface MirrorPlan {
  endpoint: string;
  target: string | null;
  newTab: boolean;
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(at, 2);
  return value;
}

function takeBool(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

function takeJoinedFlag(args: string[], name: string): string | undefined {
  const at = args.findIndex((arg) => arg.startsWith(`${name}=`));
  if (at < 0) return undefined;
  const [value] = args.splice(at, 1);
  return value.slice(name.length + 1);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const SHAPE = "a ws:// browser url, or http://127.0.0.1:9222";

/** an endpoint is either an exact browser websocket or the http address that hands one out */
export function parseEndpointArg(value: string, flag: string): string {
  const text = value.trim();
  if (/^\d+$/.test(text)) return `http://127.0.0.1:${mirrorPort(text, flag)}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`invalid ${flag} ${value} (${SHAPE})`);
  }
  const invalid = (why: string) => new Error(`invalid ${flag} ${value} (${why})`);
  if (url.protocol === "wss:" || url.protocol === "https:") {
    const plain = url.protocol === "wss:" ? "ws" : "http";
    throw invalid(`a browser on this machine speaks ${plain}, not ${url.protocol.slice(0, -1)}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "http:") throw invalid(SHAPE);
  if (url.username || url.password) throw invalid("a debugging endpoint carries no sign in");
  if (url.search || url.hash) throw invalid("the address the browser prints has nothing after the path");
  if (url.hostname.startsWith("[")) throw invalid("ipv6 addresses are not supported, so 127.0.0.1");
  if (!LOOPBACK.has(url.hostname)) throw invalid("a browser on this machine, so 127.0.0.1");
  const port = mirrorPort(url.port, flag);
  if (url.protocol === "ws:") {
    if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      throw invalid("the path should be /devtools/browser/<id>");
    }
    return `ws://127.0.0.1:${port}${url.pathname}`;
  }
  if (url.pathname !== "/" && url.pathname !== "") throw invalid(SHAPE);
  return `http://127.0.0.1:${port}`;
}

function mirrorPort(value: string | undefined, flag = "--port"): number {
  if (!value) throw new Error(`invalid ${flag} (it needs the port the browser is on)`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid ${flag} ${value} (a number between 1 and 65535)`);
  }
  return port;
}

/** reads both what a person types and what we pass ourselves when opening the pane */
export function takeMirrorFlags(args: string[]): MirrorRequest | null {
  const mirror = takeBool(args, "--mirror");
  const resolved = takeJoinedFlag(args, "--mirror-cdp");
  const cdp = takeFlag(args, "--cdp");
  const port = takeFlag(args, "--port");
  const browser = takeFlag(args, "--browser");
  const userDataDir = takeFlag(args, "--user-data-dir");
  const target = takeFlag(args, "--target") ?? takeJoinedFlag(args, "--mirror-target");
  const newTab = takeBool(args, "--new-tab") || takeBool(args, "--mirror-new-tab");
  if (!mirror) {
    for (const [flag, given] of [
      ["--cdp", cdp !== undefined],
      ["--port", port !== undefined],
      ["--browser", browser !== undefined],
      ["--user-data-dir", userDataDir !== undefined],
      ["--target", target !== undefined],
      ["--new-tab", newTab],
    ] as const) {
      if (given) throw new Error(`${flag} only applies to --mirror`);
    }
    return null;
  }
  const chosen = [
    ["--cdp", cdp !== undefined],
    ["--port", port !== undefined],
    ["--browser", browser !== undefined],
    ["--user-data-dir", userDataDir !== undefined],
  ].filter(([, given]) => given);
  if (chosen.length > 1) {
    throw new Error(`${chosen[0][0]} and ${chosen[1][0]} pick different browsers, so pass one`);
  }
  if (target !== undefined && newTab) {
    throw new Error("--target picks a tab and --new-tab makes one, so pass only one of them");
  }
  if (args.some((arg) => arg.startsWith("--ssh="))) {
    throw new Error("--mirror attaches to a browser on this machine, so it cannot use --ssh");
  }
  if (args.includes("--app-mode")) {
    throw new Error("--mirror shows a browser you already have open, so it cannot use --app-mode");
  }
  if (browser !== undefined && !browserNames().includes(browser)) {
    throw new Error(`unknown --browser ${browser} (${browserNames().join(", ")})`);
  }
  const endpoint =
    resolved !== undefined
      ? parseEndpointArg(resolved, "--mirror-cdp")
      : cdp !== undefined
        ? parseEndpointArg(cdp, "--cdp")
        : port !== undefined
          ? `http://127.0.0.1:${mirrorPort(port)}`
          : null;
  return {
    endpoint,
    browser: browser ?? null,
    userDataDir: userDataDir ?? null,
    target: target ?? null,
    newTab,
  };
}

export function mirrorArgv(plan: MirrorPlan): string[] {
  const argv = ["--mirror", `--mirror-cdp=${plan.endpoint}`];
  if (plan.target) argv.push(`--mirror-target=${plan.target}`);
  if (plan.newTab) argv.push("--mirror-new-tab");
  return argv;
}

export function turnOnDebugging(what: string): string {
  return (
    `${what}\n\n` +
    "In the browser you want to mirror, open chrome://inspect/#remote-debugging and turn\n" +
    "remote debugging on, then run this again and press Allow when the browser asks. The\n" +
    "browser does not need restarting.\n\n" +
    `Browsers too old for that switch have to be started with --remote-debugging-port=${DEFAULT_MIRROR_PORT},\n` +
    "which terminal-browser then finds with --port."
  );
}

export function describeChoices(found: Discovered[]): string {
  return found
    .map((browser) => `  --browser ${browser.browser}    ${browser.name} (${browser.root})`)
    .join("\n");
}

export function portOf(endpoint: string): number {
  return Number(new URL(endpoint).port);
}

export function isSocketEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("ws:") || endpoint.startsWith("wss:");
}

export interface ResolveOptions extends DiscoverOptions {
  live?: (port: number) => Promise<boolean>;
  check?: (endpoint: string, target: string | null) => Promise<void>;
}

/** works out which browser this is about, and that it is still there, before a pane opens */
export async function resolveMirror(
  request: MirrorRequest,
  options: ResolveOptions = {},
): Promise<MirrorPlan> {
  const live = options.live ?? reachable;
  const check = options.check ?? checkHttpEndpoint;
  const plan = (endpoint: string): MirrorPlan => ({
    endpoint,
    target: request.target,
    newTab: request.newTab,
  });

  if (request.endpoint) {
    if (isSocketEndpoint(request.endpoint)) {
      // knocking on an approval endpoint would ask the human again, so only look for a listener
      if (!(await live(portOf(request.endpoint)))) {
        throw new Error(turnOnDebugging(`nothing is listening on ${request.endpoint} any more.`));
      }
      return plan(request.endpoint);
    }
    await check(request.endpoint, request.target);
    return plan(request.endpoint);
  }

  if (request.userDataDir) {
    const found = await discoverIn(request.userDataDir, { live });
    if (!found) {
      throw new Error(turnOnDebugging(`no browser is sharing a tab from ${request.userDataDir}.`));
    }
    return plan(endpointUrl(found));
  }

  const known = options.kinds ?? browserKinds();
  const kinds = request.browser ? known.filter((kind) => kind.id === request.browser) : known;
  const found = await discoverBrowsers({ kinds, live });
  if (found.length === 1) return plan(endpointUrl(found[0]));
  if (found.length > 1) {
    throw new Error(
      `several browsers are sharing a tab, so say which one:\n\n${describeChoices(found)}`,
    );
  }
  if (request.browser) {
    const kind = known.find((entry) => entry.id === request.browser);
    throw new Error(turnOnDebugging(`${kind?.name ?? request.browser} is not sharing a tab.`));
  }
  // nothing announced itself, so the old way of starting a browser with a port is worth a look
  if (await live(DEFAULT_MIRROR_PORT)) {
    const endpoint = `http://127.0.0.1:${DEFAULT_MIRROR_PORT}`;
    await check(endpoint, request.target);
    return plan(endpoint);
  }
  throw new Error(turnOnDebugging("no browser is sharing a tab yet."));
}

interface RemoteTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

function get(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`answered ${response.statusCode}`));
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => resolve(text));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("no answer")));
    request.on("error", reject);
  });
}

export function describeTargets(targets: RemoteTarget[]): string {
  return targets
    .filter((target) => target.type === "page")
    .map((target) => `  ${target.id}  ${target.title || target.url}\n      ${target.url}`)
    .join("\n");
}

/** fail in the shell the user typed in, rather than in a pane that flashes open and shuts */
export async function checkHttpEndpoint(endpoint: string, target: string | null): Promise<void> {
  const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
  await get(`${endpoint}/json/version`, 3000).catch((error: unknown) => {
    throw new Error(turnOnDebugging(`nothing is listening for debugging on ${endpoint} (${why(error)}).`));
  });
  if (!target) return;
  const listing = await get(`${endpoint}/json/list`, 3000).catch((error: unknown) => {
    throw new Error(turnOnDebugging(`${endpoint} would not list its tabs (${why(error)}).`));
  });
  const targets = JSON.parse(listing) as RemoteTarget[];
  const wanted = targets.find((entry) => entry.id === target);
  if (!wanted) {
    const known = describeTargets(targets);
    throw new Error(`no tab ${target} on ${endpoint}${known ? `\n\ntabs:\n${known}` : ""}`);
  }
  if (wanted.type !== "page") throw new Error(`${target} is a ${wanted.type}, not a tab`);
}
