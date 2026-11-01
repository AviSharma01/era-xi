import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./eraDraftWeb.css";
import "./components/PlayerCard.css";
import { EraDraftApp } from "./eraDraftApp.js";

export function mountEraDraftWebApp(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <EraDraftApp />
    </StrictMode>,
  );
}

