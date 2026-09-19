import { matchAppRoute } from "./webRoutes.js";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Missing #app root element.");
}

async function mount(): Promise<void> {
  const route = matchAppRoute(window.location.pathname);
  if (route === "CLASSIC") {
    const { mountClassicDraft } = await import("./classicEntry.js");
    mountClassicDraft(root!);
    return;
  }
  const { mountEraDraftWebApp } = await import("./eraDraftWebApp.js");
  mountEraDraftWebApp(root!);
}

void mount();
