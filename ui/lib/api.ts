// Derives the HTTP origin from NEXT_PUBLIC_WS_URL so we can call /history
// from the same backend that serves /ws. Falls back to localhost for dev.
// Explicit NEXT_PUBLIC_API_URL wins when set.
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
const EXPLICIT_API = process.env.NEXT_PUBLIC_API_URL;

export function apiOrigin(): string {
  if (EXPLICIT_API) return EXPLICIT_API.replace(/\/$/, "");
  try {
    const u = new URL(WS_URL);
    const scheme = u.protocol === "wss:" ? "https:" : "http:";
    return `${scheme}//${u.host}`;
  } catch {
    return "http://localhost:8080";
  }
}
