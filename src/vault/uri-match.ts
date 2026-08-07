import { registrableDomain as calcRegistrableDomain } from "./public-suffix";

// Re-export registrableDomain for testing and external use
export { registrableDomain } from "./public-suffix";

export type UriMatchType = 0 | 1 | 2 | 3 | 4 | 5;
export type CipherUri = { uri: string; match: UriMatchType | null };

function parse(url: string): URL | null {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return null;
  }
}

/**
 * Check if a hostname is an IP address (IPv4 or IPv6) or single-label (localhost).
 */
function isIpOrSingleLabel(hostname: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6 (enclosed in brackets)
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  // Single label (no dots)
  if (!hostname.includes(".")) return true;
  return false;
}

export function uriMatches(pageUrl: string, cipherUri: CipherUri): boolean {
  const match = cipherUri.match ?? 0;
  if (match === 5 || match === 4) return false; // never; regex unsupported in v1

  const page = parse(pageUrl);
  const stored = parse(cipherUri.uri);
  if (page === null || stored === null) return false;

  // Guard against empty hostnames (file://, blob://)
  if (!page.hostname || !stored.hostname) return false;

  switch (match) {
    case 0: {
      // Base domain matching. For IP addresses and single-label hosts, use port-aware host
      // comparison instead, since multiple services on the same IP/localhost use different ports.
      const isPageSpecial = isIpOrSingleLabel(page.hostname);
      const isStoredSpecial = isIpOrSingleLabel(stored.hostname);

      if (isPageSpecial !== isStoredSpecial) return false;
      if (isPageSpecial) {
        // Both are IP/single-label; compare including port
        return page.host === stored.host;
      }
      // Both are regular domains; compare registrable domains
      return calcRegistrableDomain(page.hostname) === calcRegistrableDomain(stored.hostname);
    }

    case 1:
      return page.host === stored.host;

    case 2: {
      // Prefix matching with authority boundary: origins must match exactly,
      // then path-and-query must match as a prefix at path boundaries.
      if (page.origin !== stored.origin) return false;

      const storedHref = stored.href;
      const pageHref = page.href;

      // For path matching, we need to match at path component boundaries.
      // Normalize: remove trailing slash from stored for consistency
      const storedPath = storedHref.replace(/\/$/, "");

      // Direct prefix match of the stored URL
      if (!pageHref.startsWith(storedPath)) return false;

      // Ensure boundary: next char must be / (path separator) or end of string or ? (query)
      // This prevents /app matching /appeal
      const nextCharIndex = storedPath.length;
      if (nextCharIndex < pageHref.length) {
        const nextChar = pageHref[nextCharIndex];
        // Allow continuation only at path boundaries: / for path, ? for query, # for fragment
        if (nextChar !== "/" && nextChar !== "?" && nextChar !== "#") return false;
      }

      return true;
    }

    case 3:
      return page.href === stored.href;

    default:
      return false;
  }
}
