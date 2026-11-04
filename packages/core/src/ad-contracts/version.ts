/**
 * Actor/Director shared contracts, frozen. Any change to a type, schema or listed constant bumps
 * CONTRACT_VERSION (contract-v2, ...) and is announced to DirectorBot, IOS Dev, the Researcher and
 * InfrastructureBot before it merges. See README.md in this folder.
 */
export const CONTRACT_VERSION = "contract-v1.1" as const;
/** every version this code reads (session_start.contract); v1.1 is additive over v1 (README, Changes) */
export const CONTRACT_VERSIONS = ["contract-v1", "contract-v1.1"] as const;
export const CONTRACT_FROZEN = "2026-11-04" as const;
/** schema tag on every Actor/Director session-log line */
export const BH_AD_SCHEMA = "bh-ad/1" as const;
/** schema tag of a gaze replay file (synthetic mode, the replay CLI, R2 generator output) */
export const GAZE_REPLAY_SCHEMA = "bh-gaze-replay/1" as const;
/** Capacitor jsName of the native plugin (BHGazePlugin.swift) */
export const GAZE_PLUGIN_JS_NAME = "BHGaze" as const;
