/**
 * In-memory schedule cache, one per client instance. Never written to disk.
 *
 * Entries are owned by account + selected child + date, are fresh for
 * `freshMs`, usable as stale data until `maxStaleMs`, and bounded by an LRU
 * limit. `generation` changes on clear(), so a write that started before a
 * logout cannot repopulate the cache afterwards.
 */

export interface CacheOptions {
  now?: () => number;
  freshMs?: number;
  maxStaleMs?: number;
  maxEntries?: number;
}

export interface CacheHit<T> {
  value: T;
  fresh: boolean;
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

export function cacheKey(accountPersonId: number, childId: number, date: string): string {
  return `${accountPersonId}\0${childId}\0${date}`;
}

export class ScheduleCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly maxStaleMs: number;
  private readonly maxEntries: number;
  private currentGeneration = 0;

  constructor(options: CacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.freshMs = options.freshMs ?? 5 * 60 * 1000;
    this.maxStaleMs = options.maxStaleMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 64;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CacheHit<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = this.now() - entry.storedAt;
    if (age > this.maxStaleMs) {
      this.entries.delete(key);
      return null;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value, fresh: age <= this.freshMs };
  }

  /** Stores a value unless the cache was cleared since `generation` was read. */
  set(key: string, value: T, generation: number): void {
    if (generation !== this.currentGeneration) return;
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.currentGeneration += 1;
    this.entries.clear();
  }
}
