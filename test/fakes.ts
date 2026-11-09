import { resolveConfig } from "../src/config.ts";
import { JiraService } from "../src/service.ts";
import type { Ticket, TicketDetail, TicketSource, Transition } from "../src/source/types.ts";

export function ticket(key: string, status: string, extra: Partial<Ticket> = {}): Ticket {
	return {
		key,
		status,
		summary: `Summary ${key}`,
		statusCategory: "",
		sprint: "SDM Sprint 130",
		url: `https://jira/browse/${key}`,
		...extra,
	};
}

/** In-memory TicketSource that records its calls. */
export class FakeSource implements TicketSource {
	calls: string[] = [];
	tickets: Ticket[] = [ticket("SDM-1", "In Progress", { storyPoints: 3 }), ticket("SDM-2", "Backlog")];
	transitions: Transition[] = [
		{ id: "11", name: "In Review", to: "In Review" },
		{ id: "21", name: "Selected for Development", to: "In Prioritization" },
	];

	async whoami() {
		this.calls.push("whoami");
		return { name: "glemus", displayName: "Gilberto" };
	}
	async listMySprintIssues(project: string) {
		this.calls.push(`list:${project}`);
		return this.tickets;
	}
	async getIssue(key: string): Promise<TicketDetail> {
		this.calls.push(`get:${key}`);
		const t = this.tickets.find((x) => x.key === key) ?? ticket(key, "Backlog");
		return { ...t, labels: [], components: [], subtasks: [], links: [], comments: [], description: "desc" };
	}
	async getTransitions(key: string) {
		this.calls.push(`transitions:${key}`);
		return this.transitions;
	}
	async transition(key: string, to: string) {
		this.calls.push(`transition:${key}:${to}`);
		return this.transitions.find((t) => t.id === to)!;
	}
	async addComment(key: string, body: string) {
		this.calls.push(`comment:${key}:${body}`);
	}
}

export function makeService(over: Record<string, unknown> = {}) {
	const source = new FakeSource();
	const config = resolveConfig(
		{
			baseUrl: "https://jira",
			auth: { type: "bearer", token: "x" },
			projects: ["SDM"],
			statusOrder: ["In Progress", "Backlog"],
			...over,
		},
		{},
	);
	return { source, service: new JiraService({ config, sources: ["test"] }, source) };
}
