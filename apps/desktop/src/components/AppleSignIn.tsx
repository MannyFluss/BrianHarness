// Sign in with Apple UI: the skippable launch screen and the sidebar row. All state comes from
// bridge().appleAuth (transport/apple-auth.ts); nothing here touches the study or the session logs.
import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { bridge, type AppleAuthView } from "../bridge";
import { cn } from "../lib";

/** live Sign in with Apple state (null when the shell has no BHAppleAuth plugin) */
export function useAppleAuth(): AppleAuthView | null {
  const a = bridge().appleAuth;
  const [v, setV] = useState<AppleAuthView | null>(null);
  useEffect(() => {
    if (!a) return;
    let live = true;
    const off = a.onChange((x) => live && setV(x));
    void a.status().then((x) => live && setV((cur) => cur ?? x), () => {});
    return () => { live = false; off(); };
  }, [a]);
  return v;
}

const AppleLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 814 1000" aria-hidden="true" className={className} fill="currentColor">
    <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
  </svg>
);

/** HIG-style black "Sign in with Apple" button (dark UI: white variant) */
export function AppleButton({ onClick, busy, label = "Sign in with Apple", className }: { onClick: () => void; busy?: boolean; label?: string; className?: string }) {
  return (
    <button onClick={onClick} disabled={busy} data-siwa-button className={cn("eeg-tap flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-white px-4 text-[15px] font-medium text-black disabled:opacity-60", className)}>
      <AppleLogo className="size-4" /> {busy ? "Signing in…" : label}
    </button>
  );
}

/**
 * Launch screen: offered once per launch, before the first turn of a NON-study session, only when
 * nothing is stored in the Spider Cloud slot (App decides via shouldOfferAtLaunch). Skip, the X and the
 * backdrop all dismiss it; it never blocks the chat behind it from starting.
 */
export function AppleSignInScreen({ open, view, phone, onClose, gate }: { open: boolean; view: AppleAuthView | null; phone: boolean; onClose: () => void; gate?: boolean }) {
  if (!open || !view) return null;
  const busy = view.phase === "signing-in";
  const skip = () => { bridge().appleAuth?.skip(); onClose(); };
  const go = () => void bridge().appleAuth?.signIn().then((v) => { if (v.phase === "signed-in") onClose(); }, () => {});
  return (
    <>
      <button aria-label="Skip sign in" onClick={skip} className={cn("fixed inset-0 z-[60]", gate ? "cursor-default bg-background" : "bg-black/55")} {...(gate ? { "data-siwa-gate": "" } : {})} />
      <div
        role="dialog"
        aria-label="Sign in with Apple"
        data-siwa-screen
        className={cn(
          "fixed z-[61] flex flex-col gap-4 border bg-background p-5 shadow-2xl shadow-black/70",
          phone
            ? "inset-x-0 bottom-0 rounded-t-2xl border-t pb-[max(1.25rem,env(safe-area-inset-bottom))]"
            : "left-1/2 top-1/2 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl",
        )}
      >
        {phone && <span className="mx-auto -mt-2 h-1 w-10 rounded-full bg-border" />}
        <div className="flex items-start justify-between gap-3">
          <span className="font-title text-2xl tracking-tight">Connect to Spider Cloud</span>
          <button onClick={skip} aria-label="Close" className="eeg-tap -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-4" /></button>
        </div>
        <p className="text-sm leading-snug text-muted-foreground">Sign in with Apple to use the cloud models and upload your study logs automatically. You can skip this and chat right away; a device token (Spider Cloud · KEY) works too.</p>
        <AuthMessage view={view} />
        <AppleButton onClick={go} busy={busy} label={view.phase === "not-allowed" || view.phase === "error" ? "Try again" : "Sign in with Apple"} />
        <button onClick={skip} data-siwa-skip className="eeg-tap h-10 rounded-[10px] px-4 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">Skip</button>
      </div>
    </>
  );
}

function AuthMessage({ view }: { view: AppleAuthView }) {
  if (!view.message || view.phase === "signing-in") return null;
  return <div role="status" data-siwa-message={view.phase} className={cn("rounded-md border px-3 py-2 text-sm", view.phase === "not-allowed" ? "border-amber-400/40 bg-amber-400/10 text-amber-200" : "border-border bg-card text-muted-foreground")}>{view.message}</div>;
}

/** Sidebar row (above the model picker), only when BHAppleAuth says Sign in with Apple is available */
export function AppleSignInRow() {
  const view = useAppleAuth();
  if (!view?.available) return null;
  const row = "eeg-tap-row flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50";
  if (view.tokenSource === "apple") {
    return <div className={cn(row, "cursor-default hover:bg-transparent")} data-siwa-row="signed-in"><AppleLogo className="size-3" /> Signed in with Apple</div>;
  }
  const busy = view.phase === "signing-in";
  const label = busy ? "Signing in…" : view.phase === "not-allowed" || view.phase === "error" ? "Sign in with Apple · try again" : view.tokenSource === "pasted" ? "Sign in with Apple (replaces device token)" : "Sign in with Apple";
  return (
    <div className="flex flex-col gap-0.5" data-siwa-row={view.phase}>
      <button className={row} disabled={busy} onClick={() => void bridge().appleAuth?.signIn().catch(() => {})} data-siwa-row-button>
        <AppleLogo className="size-3" /> <span className="normal-case">{label}</span>
      </button>
      {view.message && !busy && <div role="status" className={cn("px-2 text-xs", view.phase === "not-allowed" ? "text-amber-300/90" : "text-muted-foreground")}>{view.message}</div>}
    </div>
  );
}
