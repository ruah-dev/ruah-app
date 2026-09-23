// src/integrations/keychain.ts — secrets that Ruah itself must keep (the Jira
// API token) go to the macOS Keychain via /usr/bin/security, service "ruah",
// account "<integrationId>:<site>". Never to files, never to logs: the secret
// only travels as an execFile argument, and every error message is built here
// without the arguments and scrubbed of the secret.
import { redact, CliError, type Runner, defaultRunner } from "./exec.js";

export const KEYCHAIN_SERVICE = "ruah";
const SECURITY_BIN = "/usr/bin/security";
/** `security` exit status for errSecItemNotFound. */
const NOT_FOUND = 44;

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

export class Keychain implements SecretStore {
  private readonly run: Runner;
  private readonly service: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: { runner?: Runner; service?: string; platform?: NodeJS.Platform } = {}) {
    this.run = options.runner ?? defaultRunner;
    this.service = options.service ?? KEYCHAIN_SERVICE;
    this.platform = options.platform ?? process.platform;
  }

  private ensureMac(): void {
    if (this.platform !== "darwin") throw new KeychainError("secure token storage needs the macOS Keychain (not available on this platform)");
  }

  private async exec(op: string, args: string[], secret?: string): Promise<{ code: number; stdout: string }> {
    try {
      const result = await this.run(SECURITY_BIN, args, { timeoutMs: 10_000 });
      return { code: result.code, stdout: result.stdout };
    } catch (err) {
      const reason = err instanceof CliError ? err.message : "could not run security";
      throw new KeychainError(redact(`keychain ${op} failed: ${reason}`, [secret]));
    }
  }

  async get(account: string): Promise<string | null> {
    this.ensureMac();
    const { code, stdout } = await this.exec("read", ["find-generic-password", "-s", this.service, "-a", account, "-w"]);
    if (code === NOT_FOUND) return null;
    if (code !== 0) throw new KeychainError(`keychain read failed (security exit ${code})`);
    const secret = stdout.replace(/\r?\n$/, "");
    return secret.length > 0 ? secret : null;
  }

  async set(account: string, secret: string): Promise<void> {
    this.ensureMac();
    if (secret.length === 0) throw new KeychainError("refusing to store an empty secret");
    const { code } = await this.exec("write", ["add-generic-password", "-U", "-s", this.service, "-a", account, "-w", secret], secret);
    if (code !== 0) throw new KeychainError(`keychain write failed (security exit ${code})`);
  }

  async delete(account: string): Promise<boolean> {
    this.ensureMac();
    const { code } = await this.exec("delete", ["delete-generic-password", "-s", this.service, "-a", account]);
    if (code === NOT_FOUND) return false;
    if (code !== 0) throw new KeychainError(`keychain delete failed (security exit ${code})`);
    return true;
  }
}

/** In-memory SecretStore for tests and non-macOS development. */
export class MemorySecretStore implements SecretStore {
  readonly secrets = new Map<string, string>();
  get(account: string): Promise<string | null> {
    return Promise.resolve(this.secrets.get(account) ?? null);
  }
  set(account: string, secret: string): Promise<void> {
    this.secrets.set(account, secret);
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.secrets.delete(account));
  }
}
