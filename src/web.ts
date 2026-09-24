import { matchAppRoute } from "./webRoutes.js";
import noticesUrl from "./assets/THIRD_PARTY_NOTICES.txt?url";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Missing #app root element.");
}

const noticesLink = document.createElement("a");
noticesLink.className = "third-party-notices-link";
noticesLink.href = noticesUrl;
noticesLink.target = "_blank";
noticesLink.rel = "noopener";
noticesLink.textContent = "Data attribution & font licenses";
document.body.append(noticesLink);

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
