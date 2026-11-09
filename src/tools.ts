import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { groupByStatus, ticketContext, ticketLine } from "./format.ts";
import type { JiraService } from "./service.ts";
import { describeTransitions, findTransition } from "./source/types.ts";

type GetService = (cwd: string) => JiraService;

const KEY = Type.String({ description: "Jira issue key, e.g. SDM-123", pattern: "^[A-Za-z][A-Za-z0-9_]+-[0-9]+$" });

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

/** Shared rule for every write: only on the user's explicit request. */
const ON_DEMAND =
	"only when the user's latest message explicitly asks for it for that specific ticket. Never do it on your own initiative (e.g. after finishing work, or because it seems like the logical next step); suggest it in your reply instead.";

const TicketSummary = Type.Object({
	key: Type.String(),
	summary: Type.String(),
	status: Type.String(),
	storyPoints: Type.Optional(Type.Number()),
	url: Type.String(),
});

export function registerJiraTools(pi: ExtensionAPI, service: GetService) {
	pi.registerTool(
		defineTool({
			name: "jira_my_sprint",
			label: "Jira: my sprint",
			description:
				"List the Jira tickets assigned to the current user in the active sprint, grouped by status. Use it when the user asks about their tickets, their sprint, or what to work on.",
			promptSnippet: "List my Jira tickets in the active sprint",
			parameters: Type.Object({
				project: Type.Optional(Type.String({ description: "Project key, e.g. SDM. Omit for all configured projects." })),
			}),
			outputSchema: Type.Object({
				projects: Type.Array(
					Type.Object({ project: Type.String(), sprint: Type.Optional(Type.String()), tickets: Type.Array(TicketSummary) }),
				),
			}),
			annotations: READ,
			async execute(_id, params, signal, _onUpdate, ctx) {
				const svc = service(ctx.cwd);
				const projects = params.project ? [params.project.toUpperCase()] : svc.config.projects;
				const sections: string[] = [];
				const data = [];
				for (const project of projects) {
					const tickets = await svc.listMine(project, signal);
					const sprint = tickets[0]?.sprint;
					data.push({
						project,
						...(sprint && { sprint }),
						tickets: tickets.map(({ key, summary, status, storyPoints, url }) => ({
							key,
							summary,
							status,
							url,
							...(storyPoints !== undefined && { storyPoints }),
						})),
					});
					const lines = [`# ${project}${sprint ? ` · ${sprint}` : ""} · ${tickets.length} tickets`];
					if (tickets.length === 0) lines.push("", "No tickets assigned in the active sprint.");
					for (const [status, list] of groupByStatus(tickets, svc.config.statusOrder)) {
						lines.push("", `## ${status} (${list.length})`, ...list.map((t) => `- ${ticketLine(t)}`));
					}
					sections.push(lines.join("\n"));
				}
				return {
					content: [{ type: "text", text: sections.join("\n\n") }],
					structuredContent: { projects: data },
					details: undefined,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "jira_get_issue",
			label: "Jira: ticket",
			description:
				"Get a Jira ticket: status, story points, sprint, description, acceptance criteria, subtasks, links and recent comments. Use it whenever the user mentions a ticket key like SDM-123 and you don't already have its content.",
			promptSnippet: "Read a Jira ticket by key",
			parameters: Type.Object({ key: KEY }),
			annotations: READ,
			async execute(_id, params, signal, _onUpdate, ctx) {
				const detail = await service(ctx.cwd).getIssue(params.key, signal);
				return { content: [{ type: "text", text: ticketContext(detail) }], details: { key: detail.key } };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "jira_transition",
			label: "Jira: move ticket",
			description:
				"Move a Jira ticket to another status. The user must approve each call in a confirmation dialog. If `to` doesn't match, the error lists the valid transitions.",
			promptSnippet: "Move a Jira ticket to another status (asks the user)",
			promptGuidelines: [`Call jira_transition ${ON_DEMAND}`],
			parameters: Type.Object({
				key: KEY,
				to: Type.String({ description: "Target status (e.g. \"In Review\") or transition name" }),
			}),
			annotations: WRITE,
			executionMode: "sequential",
			async execute(_id, params, signal, _onUpdate, ctx) {
				const svc = service(ctx.cwd);
				const key = params.key.toUpperCase();
				assertCanWrite(svc, ctx);
				const [detail, available] = await Promise.all([svc.getIssue(key, signal), svc.getTransitions(key, signal)]);
				const match = findTransition(available, params.to);
				if (!match) {
					throw new Error(`${key} (${detail.status}): no transition to "${params.to}". Valid: ${describeTransitions(available)}`);
				}
				const approved = await ctx.ui.confirm(
					`The agent wants to move ${key}`,
					`${detail.summary}\n\n${detail.status} → ${match.to}`,
				);
				if (!approved) throw new Error(`The user declined moving ${key}. Do not retry unless they ask again.`);
				await svc.transition(key, match.id, signal);
				return {
					content: [{ type: "text", text: `${key} moved: ${detail.status} → ${match.to}` }],
					details: { key, from: detail.status, to: match.to },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "jira_comment",
			label: "Jira: comment",
			description:
				"Add a comment to a Jira ticket. The user must approve the exact text in a confirmation dialog. Jira Data Center uses wiki markup: *bold*, {{code}}, {code}…{code}, '* ' bullets, h3. headings.",
			promptSnippet: "Comment on a Jira ticket (asks the user)",
			promptGuidelines: [`Call jira_comment ${ON_DEMAND}`],
			parameters: Type.Object({
				key: KEY,
				body: Type.String({ description: "Comment text in Jira wiki markup" }),
			}),
			annotations: WRITE,
			executionMode: "sequential",
			async execute(_id, params, signal, _onUpdate, ctx) {
				const svc = service(ctx.cwd);
				const key = params.key.toUpperCase();
				const body = params.body.trim();
				if (!body) throw new Error("Comment body is empty");
				assertCanWrite(svc, ctx);
				const preview = body.length > 1200 ? `${body.slice(0, 1200)}\n… (${body.length} characters)` : body;
				const approved = await ctx.ui.confirm(`The agent wants to comment on ${key}`, preview);
				if (!approved) throw new Error(`The user declined the comment on ${key}. Do not retry unless they ask again.`);
				await svc.addComment(key, body, signal);
				return {
					content: [{ type: "text", text: `Comment added to ${key}` }],
					details: { key, chars: body.length },
				};
			},
		}),
	);
}

/** Every write needs a human to approve it; without a UI (print/JSON, headless sub-agents) it is blocked. */
function assertCanWrite(svc: JiraService, ctx: ExtensionToolContext) {
	if (svc.config.writeMode === "readonly") throw new Error("Jira is read-only here (writeMode: readonly)");
	if (!ctx.hasUI) throw new Error("Jira writes need interactive approval and no UI is available; ask the user to do it from /jira");
}
