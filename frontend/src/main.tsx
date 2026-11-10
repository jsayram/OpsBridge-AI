import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

try {
  if (localStorage.getItem("opsbridge-theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {
  /* storage can be blocked; the default theme still works */
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
