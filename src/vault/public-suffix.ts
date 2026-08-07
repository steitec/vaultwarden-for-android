import { PUBLIC_SUFFIX_RULES } from "./public-suffix-data";

/** Holds a lookup structure for the Public Suffix List, built at module load. */
interface PSLEntry {
  /** Exact-match rules for this label count */
  exact: Set<string>;
  /** Wildcard suffix patterns for this label count (e.g., Set(["ck"]) for "*.ck") */
  wildcards: Set<string>;
  /** Exception rule exists for this label count (as a set of negated rules) */
  exception: Set<string>;
}

/** Indexes rules by label count for O(1) lookup. */
const INDEX: Map<number, PSLEntry> = new Map();

/** Build the PSL lookup structure once at module load. */
function buildIndex() {
  const lines = PUBLIC_SUFFIX_RULES.trim().split("\n");

  for (const line of lines) {
    const rule = line.trim();
    if (!rule || rule.startsWith("//")) continue;

    const labelCount = rule.split(".").length;
    if (!INDEX.has(labelCount)) {
      INDEX.set(labelCount, { exact: new Set(), wildcards: new Set(), exception: new Set() });
    }

    const entry = INDEX.get(labelCount)!;
    if (rule.startsWith("!")) {
      // Exception rule: remove the leading ! and add to exception set
      entry.exception.add(rule.substring(1));
    } else if (rule.startsWith("*.")) {
      // Wildcard rule: store the suffix part (e.g., "*.ck" -> "ck")
      entry.wildcards.add(rule.substring(2)); // Remove "*."
    } else {
      // Exact rule
      entry.exact.add(rule);
    }
  }
}

buildIndex();

/**
 * Returns the public suffix (eTLD) for a hostname, or null if the hostname
 * is itself a public suffix. Takes a bare hostname, not a URL.
 */
export function getPublicSuffix(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");

  // Search from longest to shortest suffix
  for (let len = labels.length; len >= 1; len--) {
    const suffix = labels.slice(-len).join(".");
    const entry = INDEX.get(len);
    if (!entry) continue;

    // Check for exception rule first (they override wildcards)
    if (entry.exception.has(suffix)) {
      return suffix;
    }

    // Check for exact match
    if (entry.exact.has(suffix)) {
      return suffix;
    }

    // Check for wildcard rule matching
    // A wildcard rule at length N applies if the last (N-1) labels match the wildcard suffix
    if (entry.wildcards.size > 0 && len < labels.length) {
      // The wildcard pattern is for the last (N-1) labels
      // So we check if the suffix excluding the first label matches any wildcard
      const wildcardSuffix = labels.slice(-(len - 1)).join(".");
      if (entry.wildcards.has(wildcardSuffix)) {
        // Wildcard matches one more label above
        return labels.slice(-(len + 1)).join(".");
      }
    }
  }

  return null;
}

/**
 * Returns the registrable domain (eTLD+1) for a hostname, or the hostname itself
 * if it is a public suffix or IP address/single label. Takes a bare hostname, not a URL.
 *
 * Note: This function expects a bare hostname without port. The URL.hostname property
 * automatically strips the port, so always call this with hostname, never host.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  // Empty hostname edge case
  if (!host) return host;

  // IP addresses and single-label hosts (localhost) are returned unchanged
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes(".")) {
    return host;
  }

  // IPv6 addresses
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }

  const suffix = getPublicSuffix(host);
  if (suffix === null) {
    // Not in the PSL, default to last two labels
    const labels = host.split(".");
    if (labels.length <= 2) return host;
    return labels.slice(-2).join(".");
  }

  if (suffix === host) {
    // Hostname is itself a public suffix; return a marker that won't match anything
    // This prevents two different sites under the same suffix from matching each other
    return suffix + ".~null";
  }

  // Registrable domain is the suffix plus one more label
  const labels = host.split(".");
  const suffixLabelCount = suffix.split(".").length;
  const registrable = labels.slice(-(suffixLabelCount + 1)).join(".");
  return registrable;
}
