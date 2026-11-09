import { describe, expect, it, vi } from "vitest";
import { registerJiraTools } from "../src/tools.ts";
import { makeService, ticket } from "./fakes.ts";

function setup(opts: { confirm?: boolean; hasUI?: boolean; over?: Record<string, unknown> } = {}) {
	const { source, service } = makeService(opts.over);
	const tools: Record<string, any> = {};
	registerJiraTools({ registerTool: (t: any) => (tools[t.name] = t) } as any, () => service);
	const confirm = vi.fn(async () => opts.confirm ?? true);
	const ctx = { cwd: "/repo", hasUI: opts.hasUI ?? true, ui: { confirm } };
	const call = (name: string, params: object) => tools[name].execute("call-1", params, undefined, undefined, ctx);
	const writes = () => source.calls.filter((c) => c.startsWith("transition:") || c.startsWith("comment:"));
	return { source, tools, confirm, call, writes };
}

describe("tools: registro", () => {
	it("reads are readOnly; writes are sequential with on-demand guidelines", () => {
		const { tools } = setup();
		expect(Object.keys(tools)).toEqual(["jira_my_sprint", "jira_get_issue", "jira_transition", "jira_comment"]);
		for (const n of ["jira_my_sprint", "jira_get_issue"]) expect(tools[n].annotations.readOnlyHint).toBe(true);
		for (const n of ["jira_transition", "jira_comment"]) {
			expect(tools[n].annotations.readOnlyHint).toBe(false);
			expect(tools[n].executionMode).toBe("sequential");
			expect(tools[n].promptGuidelines.join(" ")).toMatch(/explicitly asks.*Never do it on your own initiative/);
		}
	});
});

describe("jira_my_sprint", () => {
	it("groups by statusOrder and returns structured data", async () => {
		const { call } = setup();
		const res = await call("jira_my_sprint", {});
		expect(res.content[0].text).toBe(
			[
				"# SDM · SDM Sprint 130 · 2 tickets",
				"",
				"## In Progress (1)",
				"- SDM-1 · 3p · Summary SDM-1",
				"",
				"## Backlog (1)",
				"- SDM-2 · Summary SDM-2",
			].join("\n"),
		);
		expect(res.structuredContent.projects[0]).toEqual({
			project: "SDM",
			sprint: "SDM Sprint 130",
			tickets: [
				{ key: "SDM-1", summary: "Summary SDM-1", status: "In Progress", url: "https://jira/browse/SDM-1", storyPoints: 3 },
				{ key: "SDM-2", summary: "Summary SDM-2", status: "Backlog", url: "https://jira/browse/SDM-2" },
			],
		});
	});

	it("explicit project and empty sprint", async () => {
		const { source, call } = setup();
		source.tickets = [];
		const res = await call("jira_my_sprint", { project: "abc" });
		expect(source.calls).toEqual(["list:ABC"]);
		expect(res.content[0].text).toContain("No tickets assigned");
	});
});

describe("jira_get_issue", () => {
	it("returns the ticket wrapped in <jira-ticket>", async () => {
		const { call } = setup();
		const res = await call("jira_get_issue", { key: "sdm-1" });
		expect(res.content[0].text).toMatch(/^<jira-ticket key="SDM-1">\n# SDM-1: Summary SDM-1/);
	});
});

describe("jira_transition", () => {
	it("confirms with from → to, then writes", async () => {
		const { call, confirm, writes } = setup();
		const res = await call("jira_transition", { key: "sdm-1", to: "in prioritization" });
		expect(confirm).toHaveBeenCalledWith("The agent wants to move SDM-1", "Summary SDM-1\n\nIn Progress → In Prioritization");
		expect(writes()).toEqual(["transition:SDM-1:21"]);
		expect(res.content[0].text).toBe("SDM-1 moved: In Progress → In Prioritization");
	});

	it("if the user declines, it fails without writing and asks not to retry", async () => {
		const { call, writes } = setup({ confirm: false });
		await expect(call("jira_transition", { key: "SDM-1", to: "In Review" })).rejects.toThrow(/declined.*Do not retry/);
		expect(writes()).toEqual([]);
	});

	it("invalid target: lists valid transitions without asking", async () => {
		const { call, confirm, writes } = setup();
		await expect(call("jira_transition", { key: "SDM-1", to: "Done" })).rejects.toThrow(
			'SDM-1 (In Progress): no transition to "Done". Valid: "In Review", "Selected for Development" → In Prioritization',
		);
		expect(confirm).not.toHaveBeenCalled();
		expect(writes()).toEqual([]);
	});

	it("without UI it is blocked before calling Jira", async () => {
		const { source, call, confirm } = setup({ hasUI: false });
		await expect(call("jira_transition", { key: "SDM-1", to: "In Review" })).rejects.toThrow(/no UI is available/);
		expect(confirm).not.toHaveBeenCalled();
		expect(source.calls).toEqual([]);
	});

	it("readonly is blocked before calling Jira", async () => {
		const { source, call } = setup({ over: { writeMode: "readonly" } });
		await expect(call("jira_transition", { key: "SDM-1", to: "In Review" })).rejects.toThrow(/read-only/);
		expect(source.calls).toEqual([]);
	});

	it("after moving, the listing is refreshed", async () => {
		const { source, call } = setup();
		await call("jira_my_sprint", {});
		await call("jira_transition", { key: "SDM-1", to: "In Review" });
		source.tickets = [ticket("SDM-1", "In Review")];
		const res = await call("jira_my_sprint", {});
		expect(res.content[0].text).toContain("## In Review (1)");
	});
});

describe("jira_comment", () => {
	it("shows the exact text, truncates long ones and posts on approval", async () => {
		const { call, confirm, writes } = setup();
		await call("jira_comment", { key: "SDM-1", body: "  h3. Progress\n* done  " });
		expect(confirm).toHaveBeenCalledWith("The agent wants to comment on SDM-1", "h3. Progress\n* done");
		expect(writes()).toEqual(["comment:SDM-1:h3. Progress\n* done"]);

		const long = "x".repeat(1500);
		await call("jira_comment", { key: "SDM-1", body: long });
		expect((confirm.mock.calls[1] as unknown as string[])[1]).toMatch(/^x{1200}\n… \(1500 characters\)$/);
	});

	it("declined, empty and no-UI do not write", async () => {
		await expect(setup({ confirm: false }).call("jira_comment", { key: "SDM-1", body: "hello" })).rejects.toThrow(/declined/);
		const s = setup();
		await expect(s.call("jira_comment", { key: "SDM-1", body: "   " })).rejects.toThrow(/empty/);
		expect(s.confirm).not.toHaveBeenCalled();
		const headless = setup({ hasUI: false });
		await expect(headless.call("jira_comment", { key: "SDM-1", body: "hello" })).rejects.toThrow(/no UI/);
		expect(headless.writes()).toEqual([]);
	});
});
