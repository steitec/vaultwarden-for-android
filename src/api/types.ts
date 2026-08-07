export type PreloginResponse = {
  kdf: 0 | 1;
  kdfIterations: number;
  kdfMemory: number | null;
  kdfParallelism: number | null;
  salt: string | null;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** EncString of the user key, wrapped under the stretched master key */
  Key: string;
  /** EncString of the PKCS#8 RSA private key, wrapped under the user key */
  PrivateKey: string;
};

export type RawCipherUri = { uri: string | null; match: number | null };

export type RawCipher = {
  id: string;
  organizationId: string | null;
  folderId: string | null;
  type: number;
  name: string;
  favorite: boolean;
  key: string | null;
  login: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: RawCipherUri[] | null;
  } | null;
};

export type RawProfile = {
  organizations: { id: string; name: string; key: string }[] | null;
};

export type SyncResponse = {
  profile: RawProfile;
  ciphers: RawCipher[];
  folders: { id: string; name: string }[];
};
