/** In-memory TTL cache; concurrent loads of the same key are deduplicated. */
export class TtlCache {
	private entries = new Map<string, { expires: number; value: Promise<unknown> }>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(ttlMs: number, now: () => number = Date.now) {
		this.ttlMs = ttlMs;
		this.now = now;
	}

	getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.entries.get(key);
		if (hit && hit.expires > this.now()) return hit.value as Promise<T>;
		const value = load();
		this.entries.set(key, { expires: this.now() + this.ttlMs, value });
		// Never cache failures.
		value.catch(() => {
			if (this.entries.get(key)?.value === value) this.entries.delete(key);
		});
		return value;
	}

	/** Without a prefix, clears everything. */
	invalidate(prefix = ""): void {
		for (const k of this.entries.keys()) if (k.startsWith(prefix)) this.entries.delete(k);
	}
}
