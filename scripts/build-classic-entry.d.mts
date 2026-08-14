export type BuildClassicEntryOptions = {
  name: string;
  input: string;
  globalName: string;
  root?: string;
  outDir?: string;
};

export declare function buildClassicEntry(options: BuildClassicEntryOptions): Promise<void>;
