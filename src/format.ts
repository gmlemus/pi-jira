import type { Ticket, TicketDetail } from "./source/types.ts";

const MAX_COMMENTS = 5;
const MAX_FIELD_CHARS = 6_000;

/** Sorts by `statusOrder`; unlisted statuses go last, alphabetically. */
export function groupByStatus(tickets: Ticket[], statusOrder: string[]): [string, Ticket[]][] {
	const rank = (s: string) => {
		const i = statusOrder.findIndex((o) => o.toLowerCase() === s.toLowerCase());
		return i === -1 ? statusOrder.length : i;
	};
	return [...Map.groupBy(tickets, (t) => t.status)].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

export function ticketLine(t: Ticket): string {
	const sp = t.storyPoints === undefined ? "" : ` · ${t.storyPoints}p`;
	return `${t.key}${sp} · ${t.summary}`;
}

/** Full ticket as Markdown, meant both for the agent and for display. */
export function ticketMarkdown(d: TicketDetail): string {
	const meta = [
		`**Status:** ${d.status}`,
		d.type && `**Type:** ${d.type}`,
		d.priority && `**Priority:** ${d.priority}`,
		d.storyPoints !== undefined && `**Story points:** ${d.storyPoints}`,
		d.sprint && `**Sprint:** ${d.sprint}`,
		d.assignee && `**Assignee:** ${d.assignee}`,
		d.reporter && `**Reporter:** ${d.reporter}`,
		d.parent && `**Parent:** ${d.parent}`,
		d.labels.length > 0 && `**Labels:** ${d.labels.join(", ")}`,
		d.components.length > 0 && `**Components:** ${d.components.join(", ")}`,
	].filter(Boolean);

	const out = [`# ${d.key}: ${d.summary}`, "", meta.join(" · "), "", d.url];
	if (d.description) out.push("", "## Description", "", clip(wikiToMarkdown(d.description)));
	if (d.acceptanceCriteria) out.push("", "## Acceptance criteria", "", clip(wikiToMarkdown(d.acceptanceCriteria)));
	if (d.subtasks.length) out.push("", "## Subtasks", "", ...d.subtasks.map(linkLine));
	if (d.links.length) out.push("", "## Links", "", ...d.links.map((l) => `${linkLine(l)} (${l.type})`));
	if (d.comments.length) {
		const recent = d.comments.slice(-MAX_COMMENTS);
		const skipped = d.comments.length - recent.length;
		out.push("", `## Comments${skipped ? ` (latest ${recent.length} of ${d.comments.length})` : ""}`);
		for (const c of recent) out.push("", `**${c.author}** · ${c.created.slice(0, 10)}`, "", clip(wikiToMarkdown(c.body)));
	}
	return out.join("\n");
}

/** Ticket wrapped for the model; the tag lets it refer to the ticket unambiguously. */
export function ticketContext(d: TicketDetail): string {
	return [`<jira-ticket key="${d.key}">`, ticketMarkdown(d), "</jira-ticket>"].join("\n");
}

function linkLine(l: { key: string; summary?: string; status?: string }): string {
	return `- ${l.key}${l.summary ? ` ${l.summary}` : ""}${l.status ? ` [${l.status}]` : ""}`;
}

function clip(s: string): string {
	return s.length <= MAX_FIELD_CHARS ? s : `${s.slice(0, MAX_FIELD_CHARS)}\n\n… (truncated, ${s.length} characters)`;
}

/** Minimal Jira wiki markup → Markdown conversion: just enough to read well. */
export function wikiToMarkdown(src: string): string {
	const blocks: string[] = [];
	// Code blocks first, so their content is left untouched.
	let s = src.replace(/\r\n/g, "\n").replace(/\{(code|noformat)(?::([^}]*))?\}([\s\S]*?)\{\1\}/g, (_, _tag, opts: string | undefined, body: string) => {
		const lang = opts?.split("|").find((o) => !o.includes("=")) ?? "";
		blocks.push(`\`\`\`${lang}\n${body.replace(/^\n|\n$/g, "")}\n\`\`\``);
		return `\u0000${blocks.length - 1}\u0000`;
	});
	s = s
		.replace(/^(#+)\s+/gm, (m) => `${"  ".repeat(m.trim().length - 1)}1. `)
		.replace(/^h([1-6])\.\s*/gm, (_, n: string) => `${"#".repeat(Number(n))} `)
		.replace(/^(\*+)\s+/gm, (m) => `${"  ".repeat(m.trim().length - 1)}- `)
		.replace(/\{\{([^}]+)\}\}/g, "`$1`")
		.replace(/\[([^|\]]+)\|([^\]]+)\]/g, "[$1]($2)")
		.replace(/(^|[\s(])\*(\S[^*\n]*?\S|\S)\*(?=[\s).,:;!?]|$)/gm, "$1**$2**")
		.replace(/^bq\.\s*/gm, "> ")
		.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, q: string) => q.trim().split("\n").map((l) => `> ${l}`).join("\n"));
	return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)]);
}
