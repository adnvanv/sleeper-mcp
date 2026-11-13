/**
 * Small fetch helpers for the outside data feeds (ESPN, Rotowire, FantasyCalc,
 * Sleeper's stats endpoints). Every request has a timeout and a generic
 * User-Agent; nothing identifying is sent.
 */

const USER_AGENT = "sleeper-mcp-dashboard (personal fantasy dashboard)";
const TIMEOUT_MS = 15 * 1000;

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} returned ${response.status}`);
  }
  return response;
}

export async function fetchJson<T>(url: string): Promise<T> {
  return (await get(url, "application/json")).json() as Promise<T>;
}

export async function fetchText(url: string): Promise<string> {
  return (await get(url, "application/rss+xml, application/xml, text/xml, */*"))
    .text();
}
