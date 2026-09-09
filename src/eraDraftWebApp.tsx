import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./eraDraftWeb.css";
import { EraDraftApp } from "./eraDraftApp.js";

export function mountEraDraftWebApp(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <EraDraftApp />
    </StrictMode>,
  );
}

