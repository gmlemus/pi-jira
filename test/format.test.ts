import { describe, expect, it } from "vitest";
import { groupByStatus, ticketMarkdown, wikiToMarkdown } from "../src/format.ts";
import type { Ticket, TicketDetail } from "../src/source/types.ts";

const t = (key: string, status: string): Ticket => ({ key, status, summary: key, statusCategory: "", url: "" });

describe("groupByStatus", () => {
	it("follows statusOrder (case-insensitive) and puts the rest last", () => {
		const groups = groupByStatus(
			[t("A", "Backlog"), t("B", "Zeta"), t("C", "In Progress"), t("D", "Backlog"), t("E", "Alpha")],
			["in progress", "Backlog"],
		);
		expect(groups.map(([s, l]) => `${s}:${l.length}`)).toEqual(["In Progress:1", "Backlog:2", "Alpha:1", "Zeta:1"]);
	});
});

describe("wikiToMarkdown", () => {
	it("converts the usual Jira DC markup", () => {
		const wiki = [
			"h2. Context",
			"See [runbook|https://wiki/x] and {{p99_latency}} is *critical*.",
			"* one",
			"** nested",
			"# step",
			"bq. quote",
			"{code:java}",
			"int *x* = 1; # leave alone",
			"{code}",
		].join("\r\n");
		expect(wikiToMarkdown(wiki)).toBe(
			[
				"## Context",
				"See [runbook](https://wiki/x) and `p99_latency` is **critical**.",
				"- one",
				"  - nested",
				"1. step",
				"> quote",
				"```java",
				"int *x* = 1; # leave alone",
				"```",
			].join("\n"),
		);
	});

	it("does not mistake multiplication for bold", () => {
		expect(wikiToMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
	});
});

describe("ticketMarkdown", () => {
	const detail: TicketDetail = {
		...t("SDM-1", "In Progress"),
		summary: "P99 alert",
		url: "https://jira/browse/SDM-1",
		storyPoints: 3,
		sprint: "SDM Sprint 130",
		description: "h3. Something",
		acceptanceCriteria: "* alert silenced",
		labels: [],
		components: [],
		subtasks: [],
		links: [{ type: "blocks", key: "SDM-2", status: "Backlog" }],
		comments: Array.from({ length: 7 }, (_, i) => ({ author: `u${i}`, created: "2026-11-0" + (i + 1), body: `c${i}` })),
	};

	it("includes metadata, sections and only the latest comments", () => {
		const md = ticketMarkdown(detail);
		expect(md).toContain("# SDM-1: P99 alert");
		expect(md).toContain("**Story points:** 3");
		expect(md).toContain("## Acceptance criteria\n\n- alert silenced");
		expect(md).toContain("- SDM-2 [Backlog] (blocks)");
		expect(md).toContain("latest 5 of 7");
		expect(md).not.toContain("c1\n");
		expect(md).toContain("c6");
	});
});
