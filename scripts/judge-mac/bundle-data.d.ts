// the virtual module scripts/judge-mac/build.ts injects into the bundle
declare module "bundle:data" {
  export const VERIFY_INPUTS: string;
  export const VERIFY_GOLD: string;
  export const BUILD: { frozen_commit: string; wrapper_commit: string; verify_inputs_sha256: string; verify_gold_sha256: string; node_min: string; wrapper_sha256: string; frozen_digest: string; frozen_sources: Array<{ path: string; sha256: string }> };
}
