export type BuildClassicEntryOptions = {
  name: string;
  input: string;
  globalName: string;
  root?: string;
  outDir?: string;
  /** npm packages whose LICENSE is prepended to the built file. */
  licences?: string[];
};

export declare function buildClassicEntry(options: BuildClassicEntryOptions): Promise<void>;
