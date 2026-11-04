// example name -> { schema file, definition, value }; shared by the contracts test and scripts/ad-contracts-sync.ts
import * as X from "../src/ad-contracts/examples.ts";

export type ExampleRef = { schema: string; def: string | null; value: unknown };
export function exampleFiles(): Record<string, ExampleRef> {
  const P = "gaze-plugin.schema.json";
  const out: Record<string, ExampleRef> = {
    "gaze-sample": { schema: "gaze-sample.schema.json", def: null, value: X.gazeSample },
    "gaze-sample-no-face": { schema: "gaze-sample.schema.json", def: null, value: X.gazeSampleNoFace },
    "plugin-start-options": { schema: P, def: "StartOptions", value: X.pluginStartOptions },
    "plugin-start-result": { schema: P, def: "StartResult", value: X.pluginStartResult },
    "plugin-status-paused": { schema: P, def: "GazeStatus", value: X.pluginStatusPaused },
    "plugin-calibrate-begin": { schema: P, def: "CalibrateOptions", value: X.pluginCalibrateBegin },
    "plugin-calibrate-end": { schema: P, def: "CalibrateResult", value: X.pluginCalibrateEnd },
    "plugin-gaze-event": { schema: P, def: "GazeBatchEvent", value: X.pluginGazeBatch },
    "gaze-replay-file": { schema: P, def: "GazeReplayFile", value: X.gazeReplayFile },
    "director-output-note": { schema: "note.schema.json", def: null, value: X.directorOutputNote },
    "director-output-no-note": { schema: "note.schema.json", def: null, value: X.directorOutputNoNote },
  };
  out["upload-envelope"] = { schema: "worker.schema.json", def: "AdUploadEnvelope", value: X.uploadEnvelope };
  out["worker-role-cap-error"] = { schema: "worker.schema.json", def: "RoleCapError", value: X.roleCapError };
  for (const [k, v] of Object.entries(X.events)) out["event-" + k.replace(/_/g, "-")] = { schema: "bh-ad-events.schema.json", def: null, value: v };
  return out;
}
