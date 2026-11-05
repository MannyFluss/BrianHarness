// E6: actor-director web entry (web/ad.html). Protocol-4's main.web.tsx / App are not involved.
//   ?demo=<name>&type=visible|blinded&tab=open|closed&layout=phone|tablet&motion=reduce&cal=intro|dots|result
//     a recorded sim snapshot (no backend, no network; same-origin JSON produced by scripts/ad-demo.mts)
//   (no ?demo) live: mock Actor/Director backends + the synthetic gaze tracker, everything in-process.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./ad.css";
import { mountAd } from "./boot";

document.documentElement.classList.add("eeg-web");
const q = new URLSearchParams(location.search);
mountAd(q).then((el) => {
  createRoot(document.getElementById("root")!).render(<StrictMode>{el}</StrictMode>);
  // screenshots: scroll the tab to its live layer
  if (q.get("tabScroll") === "bottom") setTimeout(() => document.querySelectorAll<HTMLElement>("aside[data-ad-tab], aside[data-ad-tab] > .overflow-y-auto").forEach((e) => e.scrollTo(0, 1e5)), 400);
});
