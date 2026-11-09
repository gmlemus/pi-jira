/** Backend-neutral ticket model. Adapters map their API onto these types. */

export interface Ticket {
	key: string;
	summary: string;
	status: string;
	/** Jira category: "new" | "indeterminate" | "done" (or anything else for a custom API). */
	statusCategory: string;
	type?: string;
	priority?: string;
	storyPoints?: number;
	sprint?: string;
	updated?: string;
	url: string;
}

export interface TicketComment {
	author: string;
	created: string;
	body: string;
}

export interface TicketLink {
	type: string;
	key: string;
	summary?: string;
	status?: string;
}

export interface TicketDetail extends Ticket {
	description?: string;
	acceptanceCriteria?: string;
	labels: string[];
	components: string[];
	assignee?: string;
	reporter?: string;
	parent?: string;
	subtasks: TicketLink[];
	links: TicketLink[];
	comments: TicketComment[];
}

export interface Transition {
	id: string;
	name: string;
	/** Target status. */
	to: string;
}

export interface TicketSource {
	/** Authenticated user, useful to validate credentials. */
	whoami(signal?: AbortSignal): Promise<{ name: string; displayName: string }>;
	listMySprintIssues(project: string, signal?: AbortSignal): Promise<Ticket[]>;
	getIssue(key: string, signal?: AbortSignal): Promise<TicketDetail>;
	getTransitions(key: string, signal?: AbortSignal): Promise<Transition[]>;
	/** `to` accepts a transition id, a transition name or the target status name. */
	transition(key: string, to: string, signal?: AbortSignal): Promise<Transition>;
	addComment(key: string, body: string, signal?: AbortSignal): Promise<void>;
}

/** Resolves `to` against the available transitions: id, transition name or target status. */
export function findTransition(available: Transition[], to: string): Transition | undefined {
	const wanted = to.trim().toLowerCase();
	return (
		available.find((t) => t.id === to.trim()) ??
		available.find((t) => t.name.toLowerCase() === wanted) ??
		available.find((t) => t.to.toLowerCase() === wanted)
	);
}

export function describeTransitions(available: Transition[]): string {
	return available.map((t) => (t.name === t.to ? `"${t.to}"` : `"${t.name}" → ${t.to}`)).join(", ") || "none";
}
