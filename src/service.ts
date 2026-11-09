import type { LoadedConfig } from "./config.ts";
import { TtlCache } from "./source/cache.ts";
import type { Ticket, TicketDetail, TicketSource, Transition } from "./source/types.ts";

/** Cached facade over a TicketSource, shared by the command and the tools. */
export class JiraService {
	readonly loaded: LoadedConfig;
	private readonly source: TicketSource;
	private readonly cache: TtlCache;
	/** Keys seen in the latest listing, for offline autocompletion. */
	private known = new Map<string, Ticket>();

	constructor(loaded: LoadedConfig, source: TicketSource) {
		this.loaded = loaded;
		this.source = source;
		this.cache = new TtlCache(loaded.config.cacheTtlSec * 1000);
	}

	get config() {
		return this.loaded.config;
	}

	whoami(signal?: AbortSignal) {
		return this.cache.getOrLoad("whoami", () => this.source.whoami(signal));
	}

	async listMine(project: string, signal?: AbortSignal): Promise<Ticket[]> {
		const tickets = await this.cache.getOrLoad(`list:${project}`, () => this.source.listMySprintIssues(project, signal));
		for (const t of tickets) this.known.set(t.key, t);
		return tickets;
	}

	getIssue(key: string, signal?: AbortSignal): Promise<TicketDetail> {
		return this.cache.getOrLoad(`issue:${key.toUpperCase()}`, () => this.source.getIssue(key.toUpperCase(), signal));
	}

	/** Not cached: they depend on the current status and are fetched right before transitioning. */
	getTransitions(key: string, signal?: AbortSignal): Promise<Transition[]> {
		return this.source.getTransitions(key.toUpperCase(), signal);
	}

	async transition(key: string, to: string, signal?: AbortSignal): Promise<Transition> {
		this.assertWritable();
		const t = await this.source.transition(key.toUpperCase(), to, signal);
		this.invalidateTicket(key);
		return t;
	}

	async addComment(key: string, body: string, signal?: AbortSignal): Promise<void> {
		this.assertWritable();
		await this.source.addComment(key.toUpperCase(), body, signal);
		this.cache.invalidate(`issue:${key.toUpperCase()}`);
	}

	knownTickets(): Ticket[] {
		return [...this.known.values()];
	}

	refresh(): void {
		this.cache.invalidate();
	}

	private invalidateTicket(key: string) {
		this.cache.invalidate(`issue:${key.toUpperCase()}`);
		this.cache.invalidate("list:");
	}

	private assertWritable() {
		if (this.config.writeMode === "readonly") throw new Error("Jira is read-only here (writeMode: readonly)");
	}
}
