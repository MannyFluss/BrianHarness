// Web / iOS WebView entry: same React UI, harness core running in-process (no Electron, no Node).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { setTransport } from "./bridge";
import { createInProcessTransport } from "./transport/in-process";

const transport = createInProcessTransport();
setTransport(transport);
document.documentElement.classList.add("eeg-web");
document.documentElement.dataset.platform = transport.platform;
if ((navigator as Navigator & { standalone?: boolean }).standalone || matchMedia("(display-mode: standalone)").matches) document.documentElement.classList.add("eeg-standalone");
// persist pending IndexedDB writes when iOS suspends the page
const flush = () => void transport.flush?.();
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
