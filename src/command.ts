import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { groupByStatus, ticketContext, ticketLine, ticketMarkdown } from "./format.ts";
import type { JiraService } from "./service.ts";
import type { Ticket } from "./source/types.ts";

export const TICKET_MESSAGE = "jira-ticket";
export interface TicketMessageDetails {
	key: string;
	summary: string;
	markdown: string;
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;
const BACK = "← Back";
const SUBCOMMANDS = ["refresh", "doctor", "reload"];

const A = {
	agent: "Send to agent",
	view: "View details",
	transition: "Transition",
	comment: "Comment",
	open: "Open in browser",
	copy: "Copy key",
} as const;

type Outcome = "back" | "done";

export function registerJiraCommand(
	pi: ExtensionAPI,
	deps: { service: (cwd: string) => JiraService; current: () => JiraService | undefined; reset: () => void },
) {
	pi.registerCommand("jira", {
		description: "Your Jira tickets in the active sprint (SDM-123 | refresh | doctor | reload)",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			const subs = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
			const keys = (deps.current()?.knownTickets() ?? []).map((t) => ({
				value: t.key,
				label: t.key,
				description: `${t.status} · ${t.summary}`,
			}));
			const items = [...subs, ...keys].filter((i) => i.value.toLowerCase().startsWith(p));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			try {
				if (arg === "reload") {
					deps.reset();
					deps.service(ctx.cwd);
					ctx.ui.notify("Jira config reloaded", "info");
					return;
				}
				const svc = deps.service(ctx.cwd);
				if (arg === "doctor") return await doctor(svc, ctx);
				if (arg === "refresh") {
					svc.refresh();
					ctx.ui.notify("Jira cache cleared", "info");
					if (!ctx.hasUI) return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("/jira needs an interactive UI; agents can use the jira_* tools", "error");
					return;
				}
				if (KEY_RE.test(arg)) {
					await ticketActions(pi, svc, ctx, arg.toUpperCase());
					return;
				}
				if (arg && arg !== "refresh") {
					ctx.ui.notify(`Unknown argument: ${arg}`, "warning");
					return;
				}
				await browse(pi, svc, ctx);
			} catch (err) {
				ctx.ui.notify(`Jira: ${(err as Error).message}`, "error");
			}
		},
	});
}

async function doctor(svc: JiraService, ctx: ExtensionCommandContext) {
	const me = await svc.whoami();
	const lines = [`Jira OK · ${me.displayName} (${me.name})`, `Config: ${svc.loaded.sources.join(", ")}`];
	for (const project of svc.config.projects) {
		const tickets = await svc.listMine(project);
		lines.push(`${project} · ${tickets[0]?.sprint ?? "no sprint"} · ${tickets.length} assigned tickets`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

/** Project → status → ticket → action, with "Back" on every level. */
async function browse(pi: ExtensionAPI, svc: JiraService, ctx: ExtensionCommandContext) {
	const projects = svc.config.projects;
	for (;;) {
		const project = projects.length === 1 ? projects[0] : await ctx.ui.select("Project", projects);
		if (!project) return;

		const tickets = await svc.listMine(project);
		if (tickets.length === 0) {
			ctx.ui.notify(`${project}: you have no tickets in the active sprint`, "info");
			if (projects.length === 1) return;
			continue;
		}

		const outcome = await pickStatus(pi, svc, ctx, project, tickets);
		if (outcome === "done" || projects.length === 1) return;
	}
}

async function pickStatus(
	pi: ExtensionAPI,
	svc: JiraService,
	ctx: ExtensionCommandContext,
	project: string,
	tickets: Ticket[],
): Promise<Outcome> {
	const groups: [string, Ticket[]][] = [[`All`, tickets], ...groupByStatus(tickets, svc.config.statusOrder)];
	const labels = groups.map(([s, l]) => `${s} (${l.length})`);
	const multiProject = svc.config.projects.length > 1;
	const sprint = tickets[0]?.sprint ?? project;
	for (;;) {
		const choice = await ctx.ui.select(`${sprint} · status`, multiProject ? [...labels, BACK] : labels);
		if (!choice) return "done";
		if (choice === BACK) return "back";
		const [, list] = groups[labels.indexOf(choice)];
		const outcome = await pickTicket(pi, svc, ctx, list);
		if (outcome === "done") return "done";
	}
}

async function pickTicket(pi: ExtensionAPI, svc: JiraService, ctx: ExtensionCommandContext, list: Ticket[]): Promise<Outcome> {
	const labels = list.map((t) => `${ticketLine(t)}${list.some((o) => o.status !== t.status) ? ` [${t.status}]` : ""}`);
	for (;;) {
		const choice = await ctx.ui.select("Ticket", [...labels, BACK]);
		if (!choice) return "done";
		if (choice === BACK) return "back";
		const outcome = await ticketActions(pi, svc, ctx, list[labels.indexOf(choice)].key);
		if (outcome === "done") return "done";
	}
}

async function ticketActions(pi: ExtensionAPI, svc: JiraService, ctx: ExtensionCommandContext, key: string): Promise<Outcome> {
	for (;;) {
		const detail = await svc.getIssue(key);
		const writable = svc.config.writeMode !== "readonly";
		const options = [A.agent, A.view, ...(writable ? [A.transition, A.comment] : []), A.open, A.copy, BACK];
		const action = await ctx.ui.select(`${detail.key} · ${detail.status} · ${detail.summary}`, options);
		if (!action) return "done";

		switch (action) {
			case BACK:
				return "back";

			case A.agent: {
				const instruction = await ctx.ui.input(
					`What should the agent do with ${key}?`,
					"e.g. implement the acceptance criteria (empty = analyze the ticket)",
				);
				if (instruction === undefined) continue;
				const prompt = `${instruction.trim() || `Analyze ticket ${key} and propose how to approach it.`}\n\n${ticketContext(detail)}`;
				await pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return "done";
			}

			case A.view:
				// Stays in the session; the model gets it with the next prompt, without starting a turn.
				pi.sendMessage<TicketMessageDetails>(
					{
						customType: TICKET_MESSAGE,
						content: ticketContext(detail),
						display: true,
						details: { key: detail.key, summary: detail.summary, markdown: ticketMarkdown(detail) },
					},
					ctx.isIdle() ? undefined : { deliverAs: "nextTurn" },
				);
				ctx.ui.notify(`${key} added to the agent context`, "info");
				return "done";

			case A.transition: {
				const transitions = await svc.getTransitions(key);
				if (transitions.length === 0) {
					ctx.ui.notify(`${key} has no available transitions`, "warning");
					continue;
				}
				const labels = transitions.map((t) => (t.name === t.to ? t.to : `${t.name} → ${t.to}`));
				const choice = await ctx.ui.select(`Move ${key} (now: ${detail.status})`, [...labels, BACK]);
				if (!choice || choice === BACK) continue;
				const t = transitions[labels.indexOf(choice)];
				if (!(await ctx.ui.confirm(`Move ${key}?`, `${detail.status} → ${t.to}`))) continue;
				await svc.transition(key, t.id);
				ctx.ui.notify(`${key}: ${detail.status} → ${t.to}`, "info");
				continue;
			}

			case A.comment: {
				const body = (await ctx.ui.editor(`Comment on ${key} (Jira wiki markup)`, ""))?.trim();
				if (!body) continue;
				const preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;
				if (!(await ctx.ui.confirm(`Post comment on ${key}?`, preview))) continue;
				await svc.addComment(key, body);
				ctx.ui.notify(`Comment posted on ${key}`, "info");
				continue;
			}

			case A.open: {
				const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
				const res = await pi.exec(opener, [detail.url]);
				if (res.code !== 0) ctx.ui.notify(`Could not open the browser: ${detail.url}`, "warning");
				return "done";
			}

			case A.copy:
				await copyToClipboard(key);
				ctx.ui.notify(`${key} copied`, "info");
				return "done";
		}
	}
}
