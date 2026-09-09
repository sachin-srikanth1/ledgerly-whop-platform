import * as fs from "fs";
import * as path from "path";

/**
 * A durable key/value map, used for the two pieces of state this SDK must keep
 * across restarts: the `external_id` -> connected-account mapping that makes
 * onboarding idempotent, and the set of webhook message ids already processed.
 *
 * The interface is async because any real implementation is: swap
 * {@link FileStore} for one backed by your own database and both idempotency
 * guarantees follow your database's durability rather than a local file's.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  /**
   * Store `value` under `key`.
   *
   * Implementations SHOULD make this atomic and last-writer-wins. Callers rely
   * on a completed `set` being visible to a later `get` in another process.
   */
  set(key: string, value: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * A JSON-file-backed {@link KeyValueStore}.
 *
 * Suitable for local development, examples, and single-process deployments.
 * Writes are atomic (write-temp-then-rename), so a crash mid-write leaves the
 * previous snapshot intact rather than a truncated file.
 *
 * It is NOT suitable for more than one process: two processes writing the same
 * file will clobber each other's keys, because each holds the whole map in
 * memory and rewrites all of it. It also rewrites the entire file on every
 * `set`, which is O(n) per webhook and will not keep up at volume.
 *
 * For production, implement {@link KeyValueStore} against a table with a unique
 * constraint on the key. That constraint, not this file, is what makes
 * concurrent delivery of the same webhook safe.
 */
export class FileStore implements KeyValueStore {
  private readonly filePath: string;
  private cache: Map<string, string>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cache = this.load();
  }

  private load(): Map<string, string> {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
      }

      return new Map(Object.entries(parsed as Record<string, string>));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // First run. An absent file is an empty store, not an error.
        return new Map();
      }

      // A corrupt or unreadable store is fatal. Starting empty would silently
      // re-process every webhook we had already handled and re-create every
      // account we had already onboarded.
      throw new Error(
        `Could not read store at ${this.filePath}: ${(error as Error).message}. ` +
          `Fix or remove the file. Starting with an empty store would break idempotency.`
      );
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.cache.get(key);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);

    const serialized = JSON.stringify(Object.fromEntries(this.cache), null, 2);
    const directory = path.dirname(this.filePath);
    // Same directory as the target: rename is only atomic within a filesystem.
    const tempPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.tmp`);

    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(tempPath, serialized, "utf-8");
    await fs.promises.rename(tempPath, this.filePath);
  }

  /** Number of keys held. Exposed for tests and operational logging. */
  size(): number {
    return this.cache.size;
  }
}

/** An in-memory {@link KeyValueStore}. For tests, and for nothing else. */
export class MemoryStore implements KeyValueStore {
  private readonly cache = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.cache.get(key);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
  }

  size(): number {
    return this.cache.size;
  }
}
