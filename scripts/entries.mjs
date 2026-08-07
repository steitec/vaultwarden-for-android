// The canonical list of extension entry points.
//
// Only src/background/index.ts exists as of Task 1. src/content/autofill.ts
// arrives in Task 11 and src/popup/popup.ts arrives in Task 14. The build
// (scripts/build.mjs) discovers which of these exist on disk at build time
// and only builds the ones present — it must never hard-fail because a
// future entry point doesn't exist yet.
export const ENTRIES = [
  {
    name: "background",
    input: "src/background/index.ts",
    globalName: "VaultwardenBackground",
  },
  {
    name: "autofill",
    input: "src/content/autofill.ts",
    globalName: "VaultwardenAutofill",
  },
  {
    name: "popup",
    input: "src/popup/popup.ts",
    globalName: "VaultwardenPopup",
  },
];
