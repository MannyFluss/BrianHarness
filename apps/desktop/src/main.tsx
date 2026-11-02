import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

if (window.eeg) {
  document.documentElement.classList.add("eeg-electron");
  document.documentElement.dataset.platform = window.eeg.platform;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
