/**
 * File-backed credential store for pi-ai (ChatGPT / Claude sign-in tokens, API keys).
 *  - Lives in the app's user-data dir (never the repo): <dataDir>/credentials.json
 *  - Directory 0700, file 0600, atomic tmp+rename writes, serialized modify().
 *  - Optional cipher: the desktop app passes Electron safeStorage, which on macOS encrypts with
 *    a key held in the login Keychain, so the file on disk is ciphertext.
 *  - Without a cipher the file is plain JSON in pi-ai's auth.json shape ({providerId: credential}),
 *    so `npx @earendil-works/pi-ai login openai` output can be used directly by the sim CLI.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export interface CredentialCipher {
  /** label written into the file so we know how to read it back */
  readonly kind: string;
  encrypt(plain: string): string; // returns base64
  decrypt(b64: string): string;
}

type Table = Record<string, Credential>;
interface EncryptedFile {
  version: 1;
  cipher: string;
  data: string;
}

export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string, private cipher?: CredentialCipher) {}

  private load(): Table {
    if (!existsSync(this.path)) return {};
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as Table | EncryptedFile;
    if ((raw as EncryptedFile).version === 1 && typeof (raw as EncryptedFile).data === "string" && (raw as EncryptedFile).cipher) {
      const enc = raw as EncryptedFile;
      if (!this.cipher || this.cipher.kind !== enc.cipher) throw new Error(`credentials at ${this.path} are encrypted with ${enc.cipher}; open them from the app`);
      return JSON.parse(this.cipher.decrypt(enc.data)) as Table;
    }
    return raw as Table;
  }
  private save(t: Table) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body = this.cipher ? JSON.stringify({ version: 1, cipher: this.cipher.kind, data: this.cipher.encrypt(JSON.stringify(t)) } satisfies EncryptedFile) : JSON.stringify(t, null, 2);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.serial(async () => {
      const t = this.load();
      const next = await fn(t[providerId]);
      if (next === undefined) return t[providerId];
      t[providerId] = next;
      this.save(t);
      return next;
    });
  }
  delete(providerId: string): Promise<void> {
    return this.serial(async () => {
      const t = this.load();
      if (!(providerId in t)) return;
      delete t[providerId];
      this.save(t);
    });
  }
}
