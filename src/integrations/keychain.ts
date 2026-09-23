// src/integrations/keychain.ts — secrets that Ruah itself must keep (the Jira
// API token) go to the macOS Keychain via /usr/bin/security, service "ruah",
// account "<integrationId>:<site>". Never to files, never to logs, never in a
// process argument list (other processes of the user can read argv): writes
// run `security -i` and send the command on stdin. Every error message is
// built here without the arguments and scrubbed of the secret.
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

  private async exec(op: string, args: string[], secret?: string, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const result = await this.run(SECURITY_BIN, args, { timeoutMs: 10_000, ...(input !== undefined ? { input } : {}) });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
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
    // `security -i` reads commands from stdin; double quotes delimit arguments,
    // so refuse characters that would break out of them.
    if (/["\\\r\n]/.test(secret) || /["\\\r\n]/.test(account)) throw new KeychainError("the token or account contains unsupported characters");
    const command = `add-generic-password -U -s "${this.service}" -a "${account}" -w "${secret}"\n`;
    const { code, stdout, stderr } = await this.exec("write", ["-i"], secret, command);
    // In interactive mode the exit code is 0 even when a command fails; errors are printed.
    if (code !== 0 || /error|SecKeychain/i.test(`${stdout}\n${stderr}`)) throw new KeychainError(redact(`keychain write failed (security exit ${code})`, [secret]));
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
