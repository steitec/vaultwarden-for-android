/**
 * Multi-label public suffixes. Single-label suffixes (com, net, de, ...) need no
 * entry because the default rule already takes the last two labels.
 */
export const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "com.br", "net.br", "org.br", "gov.br",
  "co.za", "org.za", "net.za", "gov.za",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw", "com.my", "com.pl",
  "co.il", "co.kr", "co.id", "co.th",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "netlify.app", "vercel.app",
  "duckdns.org", "synology.me", "myds.me", "quickconnect.to",
]);
