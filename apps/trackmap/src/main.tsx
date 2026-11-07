import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@bent/design-tokens/tokens.css";
import "@bent/ui/controls.css";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Trackmap could not find its page root.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
