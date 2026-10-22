export const APP_ROUTE_SEGMENTS = Object.freeze({
  HOME: "",
  ERA_DRAFT: "era-draft",
  CLASSIC: "classic",
  DRAFT_OFF: "draft-off",
} as const);

export type AppRoute = keyof typeof APP_ROUTE_SEGMENTS;

export function appRoutePath(route: AppRoute, base = import.meta.env.BASE_URL): string {
  const basePath = normalizedBasePath(base);
  const segment = APP_ROUTE_SEGMENTS[route];
  return segment ? `${basePath}${segment}` : basePath;
}

export function matchAppRoute(pathname: string, base = import.meta.env.BASE_URL): AppRoute | null {
  const basePath = normalizedBasePath(base);
  const normalizedPath = pathname.endsWith("/") && pathname !== basePath ? pathname.slice(0, -1) : pathname;
  for (const route of Object.keys(APP_ROUTE_SEGMENTS) as AppRoute[]) {
    const expected = appRoutePath(route, base);
    const normalizedExpected = expected.endsWith("/") && expected !== basePath ? expected.slice(0, -1) : expected;
    if (normalizedPath === normalizedExpected) return route;
  }
  if (draftOffRoomCode(pathname, base)) return "DRAFT_OFF";
  return null;
}

export function navigateToAppRoute(route: AppRoute, options: { replace?: boolean } = {}): void {
  const path = appRoutePath(route);
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function normalizedBasePath(base: string): string {
  const pathname = new URL(base, "https://era-draft.invalid").pathname;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}


export function normalizeDraftOffCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(code) ? code : null;
}

export function draftOffRoomPath(code: string, base = import.meta.env.BASE_URL): string {
  const normalized = normalizeDraftOffCode(code);
  if (!normalized) throw new Error("Invalid room code.");
  return `${appRoutePath("DRAFT_OFF", base)}/rooms/${normalized}`;
}

export function draftOffRoomCode(pathname: string, base = import.meta.env.BASE_URL): string | null {
  const prefix = `${appRoutePath("DRAFT_OFF", base)}/rooms/`;
  if (!pathname.startsWith(prefix)) return null;
  return normalizeDraftOffCode(pathname.slice(prefix.length).replace(/\/$/, ""));
}

export function navigateToDraftOffRoom(code: string): void {
  window.history.pushState(null, "", draftOffRoomPath(code));
  window.dispatchEvent(new PopStateEvent("popstate"));
}
