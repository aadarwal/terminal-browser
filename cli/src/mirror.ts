import http from "node:http";

export const DEFAULT_MIRROR_PORT = 9222;

export interface MirrorRequest {
  port: number;
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

/** reads both what a person types and what we pass ourselves when opening the pane */
export function takeMirrorFlags(args: string[]): MirrorRequest | null {
  const mirror = takeBool(args, "--mirror");
  const port = takeFlag(args, "--port") ?? takeJoinedFlag(args, "--mirror-port");
  const target = takeFlag(args, "--target") ?? takeJoinedFlag(args, "--mirror-target");
  const newTab = takeBool(args, "--new-tab") || takeBool(args, "--mirror-new-tab");
  if (!mirror) {
    for (const [flag, given] of [
      ["--port", port !== undefined],
      ["--target", target !== undefined],
      ["--new-tab", newTab],
    ] as const) {
      if (given) throw new Error(`${flag} only applies to --mirror`);
    }
    return null;
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
  return { port: mirrorPort(port), target: target ?? null, newTab };
}

function mirrorPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MIRROR_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port ${value} (a number between 1 and 65535)`);
  }
  return port;
}

export function mirrorArgv(request: MirrorRequest): string[] {
  const argv = ["--mirror", `--mirror-port=${request.port}`];
  if (request.target) argv.push(`--mirror-target=${request.target}`);
  if (request.newTab) argv.push("--mirror-new-tab");
  return argv;
}

export function mirrorOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
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

export function missingEndpoint(port: number, why: string): string {
  return (
    `nothing is listening for debugging on ${mirrorOrigin(port)} (${why})\n` +
    `start the browser you want to mirror with --remote-debugging-port=${port}`
  );
}

export function describeTargets(targets: RemoteTarget[]): string {
  return targets
    .filter((target) => target.type === "page")
    .map((target) => `  ${target.id}  ${target.title || target.url}\n      ${target.url}`)
    .join("\n");
}

/** fail in the shell the user typed in, rather than in a pane that flashes open and shuts */
export async function checkMirrorEndpoint(request: MirrorRequest): Promise<void> {
  const origin = mirrorOrigin(request.port);
  await get(`${origin}/json/version`, 3000).catch((error: unknown) => {
    throw new Error(missingEndpoint(request.port, error instanceof Error ? error.message : String(error)));
  });
  if (!request.target) return;
  const listing = await get(`${origin}/json/list`, 3000).catch((error: unknown) => {
    throw new Error(missingEndpoint(request.port, error instanceof Error ? error.message : String(error)));
  });
  const targets = JSON.parse(listing) as RemoteTarget[];
  const wanted = targets.find((target) => target.id === request.target);
  if (!wanted) {
    const known = describeTargets(targets);
    throw new Error(`no tab ${request.target} on ${origin}${known ? `\n\ntabs:\n${known}` : ""}`);
  }
  if (wanted.type !== "page") throw new Error(`${request.target} is a ${wanted.type}, not a tab`);
}
