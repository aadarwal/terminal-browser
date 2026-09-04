import { DEFAULT_MIRROR_PORT, endpointOf, parseEndpoint } from "./cdp";
import type { CdpEndpoint } from "./cdp";

export interface MirrorSpec {
  endpoint: CdpEndpoint;
  targetId: string | null;
  newTab: boolean;
}

function flagValue(argv: string[], flag: string): string | null {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
}

export function mirrorFromArgv(argv: string[]): MirrorSpec | null {
  if (!argv.includes("--mirror")) return null;
  const port = flagValue(argv, "--mirror-port");
  const endpoint = port ? parseEndpoint(port) : endpointOf(DEFAULT_MIRROR_PORT);
  return {
    endpoint,
    targetId: flagValue(argv, "--mirror-target"),
    newTab: argv.includes("--mirror-new-tab"),
  };
}
