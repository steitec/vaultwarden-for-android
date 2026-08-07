import { MULTI_LABEL_SUFFIXES } from "./public-suffix";

export type UriMatchType = 0 | 1 | 2 | 3 | 4 | 5;
export type CipherUri = { uri: string; match: UriMatchType | null };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (IPV4.test(host) || host.includes(":")) return host;

  const labels = host.split(".");
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function parse(url: string): URL | null {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return null;
  }
}

export function uriMatches(pageUrl: string, cipherUri: CipherUri): boolean {
  const match = cipherUri.match ?? 0;
  if (match === 5 || match === 4) return false; // never; regex unsupported in v1

  const page = parse(pageUrl);
  const stored = parse(cipherUri.uri);
  if (page === null || stored === null) return false;

  switch (match) {
    case 0:
      return registrableDomain(page.hostname) === registrableDomain(stored.hostname);
    case 1:
      return page.host === stored.host;
    case 2:
      return page.href.startsWith(stored.href.replace(/\/$/, ""));
    case 3:
      return page.href === stored.href;
  }
}
