import { parseEndpoint } from "./cdp";
import type { CdpEndpoint } from "./cdp";

export interface MirrorSpec {
  endpoint: CdpEndpoint;
  targetId: string | null;
  newTab: boolean;
}

function flagValue(argv: string[], flag: string): string | null {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
}

/** the cli works out which browser to attach to and hands us the endpoint it settled on */
export function mirrorFromArgv(argv: string[]): MirrorSpec | null {
  if (!argv.includes("--mirror")) return null;
  const endpoint = flagValue(argv, "--mirror-cdp");
  if (!endpoint) throw new Error("--mirror needs the endpoint the cli resolved (--mirror-cdp=)");
  return {
    endpoint: parseEndpoint(endpoint),
    targetId: flagValue(argv, "--mirror-target"),
    newTab: argv.includes("--mirror-new-tab"),
  };
}
