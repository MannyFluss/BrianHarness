/**
 * v1.5 Mac: input-mode selector (fixed per session) + Actor/Director model pickers (changeable mid-session).
 * Defaults for the first Mac pilot: Pointer mode, Actor gpt-oss:20b-cloud, Director gpt-oss:120b-cloud.
 * Leak-judge (gemma4:cloud) is intentionally absent.
 */
import { useState } from "react";
import { DEFAULT_ACTOR_MODEL, DEFAULT_DIRECTOR_MODEL, INPUT_MODES, isCloudModel, modelRefusal, type InputMode, type ModelRole } from "@brianharness/core/ad-contracts";
import { cn } from "../lib";

/** suggested cloud tags for the AD dogfood picker (Worker allowlist may be narrower at runtime) */
export const AD_SUGGESTED_MODELS = [
  DEFAULT_ACTOR_MODEL,
  DEFAULT_DIRECTOR_MODEL,
  "gpt-oss:20b-cloud",
  "gpt-oss:120b-cloud",
  "gemma3:27b-cloud",
] as const;

const MODE_LABEL: Record<InputMode, string> = { pointer: "Pointer", gaze: "Eye tracking", none: "None" };
const MODE_HINT: Record<InputMode, string> = {
  pointer: "Clicks / hovers / dwells on interactive controls only (first Mac pilot)",
  gaze: "MediaPipe gaze (parked for the Pointer pilot)",
  none: "Chat + footprint only; no gaze or pointer evidence",
};

export function InputModePicker({ value, onChange, locked }: { value: InputMode; onChange: (m: InputMode) => void; locked?: boolean }) {
  return (
    <div className="flex flex-col gap-1" data-ad-input-mode={value}>
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Director input</span>
      <div className="flex flex-wrap gap-1">
        {INPUT_MODES.map((m) => (
          <button
            key={m}
            type="button"
            disabled={locked && m !== value}
            title={locked && m !== value ? "Input mode is fixed for this session — start a new session to change it" : MODE_HINT[m]}
            onClick={() => !locked && onChange(m)}
            className={cn(
              "eeg-tap-chip rounded-md px-2 py-1 text-xs uppercase tracking-wider",
              value === m ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
              locked && m !== value && "opacity-40",
            )}
            data-ad-mode-option={m}
            aria-pressed={value === m}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {locked && <span className="text-[10px] text-muted-foreground/70">Fixed for this session</span>}
    </div>
  );
}

export function AdModelPicker({
  role, value, onChange, suggestions = AD_SUGGESTED_MODELS,
}: {
  role: ModelRole; value: string; onChange: (tag: string) => string | null; suggestions?: readonly string[];
}) {
  const [draft, setDraft] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const apply = (tag: string) => {
    const t = tag.trim();
    const r = modelRefusal(t) ?? (isCloudModel(t) ? onChange(t) : `${JSON.stringify(t)} is not a :cloud model tag`);
    if (r) { setErr(r); return; }
    setErr(null); setDraft(t);
  };
  const uniq = [...new Set(suggestions.filter((s) => isCloudModel(s) && s !== "gemma4:cloud"))];
  return (
    <div className="flex min-w-0 flex-col gap-1" data-ad-model-role={role}>
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">{role === "actor" ? "Actor model" : "Director model"}</span>
      <div className="flex flex-wrap gap-1">
        {uniq.map((m) => (
          <button key={m} type="button" onClick={() => apply(m)} className={cn("eeg-tap-chip rounded px-1.5 py-0.5 font-mono text-[10px]", value === m ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")} data-ad-model-option={m}>
            {m.replace(/-cloud$/, "")}
          </button>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => apply(draft)}
        onKeyDown={(e) => e.key === "Enter" && apply(draft)}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]"
        placeholder={role === "actor" ? DEFAULT_ACTOR_MODEL : DEFAULT_DIRECTOR_MODEL}
        data-ad-model-input={role}
      />
      {err && <div className="text-[10px] text-red-300" data-ad-model-error={role}>{err}</div>}
    </div>
  );
}

/** dogfood interactive controls under an Actor reply (Pointer pilot). AOIs aN.c1..c3 are marked interactive. */
export const POINTER_DOGFOOD_CONTROLS = ["Show the math", "Give an example", "Skip"] as const;
export function PointerDogfoodControls({ msgId }: { msgId: string }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-ad-pointer-controls={msgId}>
      {POINTER_DOGFOOD_CONTROLS.map((label, i) => (
        <button
          key={label}
          type="button"
          data-msg={msgId}
          data-aoi={`${msgId}.c${i + 1}`}
          data-interactive="true"
          data-excerpt={label}
          className="rounded-md border border-border/80 bg-secondary/40 px-2.5 py-1 text-xs text-foreground hover:border-signal hover:bg-accent"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
