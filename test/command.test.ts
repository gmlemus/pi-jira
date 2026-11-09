import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ copyToClipboard: vi.fn(async () => {}) }));

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { registerJiraCommand, TICKET_MESSAGE } from "../src/command.ts";
import type { JiraService } from "../src/service.ts";
import { makeService } from "./fakes.ts";

/**
 * Fakes pi + UI. `answers` replies to select/input/confirm/editor in order; each
 * select answer is matched by prefix against the offered options.
 */
function harness(service: JiraService, answers: (string | boolean | undefined)[], opts: { hasUI?: boolean; idle?: boolean } = {}) {
	let command: any;
	const pi = {
		registerCommand: (_: string, c: any) => (command = c),
		sendUserMessage: vi.fn(async () => {}),
		sendMessage: vi.fn(),
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
	};
	registerJiraCommand(pi as any, { service: () => service, current: () => service, reset: () => {} });

	const log: string[] = [];
	const next = (kind: string, title: string) => {
		if (answers.length === 0) throw new Error(`No answer for ${kind}: ${title}`);
		return answers.shift();
	};
	const ui = {
		select: vi.fn(async (title: string, options: string[]) => {
			const a = next("select", title);
			log.push(`select ${title} [${options.join(" | ")}] -> ${a}`);
			if (a === undefined) return undefined;
			const match = options.find((o) => o.startsWith(a as string));
			if (!match) throw new Error(`"${a}" is not in [${options.join(" | ")}]`);
			return match;
		}),
		input: vi.fn(async (title: string) => next("input", title) as string | undefined),
		editor: vi.fn(async (title: string) => next("editor", title) as string | undefined),
		confirm: vi.fn(async (title: string, msg: string) => {
			log.push(`confirm ${title} ${msg}`);
			return next("confirm", title) as boolean;
		}),
		notify: vi.fn(),
	};
	const ctx = { cwd: "/repo", hasUI: opts.hasUI ?? true, isIdle: () => opts.idle ?? true, ui };
	const run = async (args = "") => {
		await command.handler(args, ctx);
		expect(answers, "unused answers").toEqual([]);
	};
	return { pi, ui, log, run, command };
}

describe("/jira", () => {
	let svc: ReturnType<typeof makeService>;
	beforeEach(() => {
		svc = makeService();
	});

	it("statuses sorted by statusOrder with counts, All first", async () => {
		const h = harness(svc.service, [undefined]);
		await h.run();
		expect(h.log[0]).toContain("SDM Sprint 130 · status [All (2) | In Progress (1) | Backlog (1)]");
	});

	it("send to agent injects the ticket with the instruction", async () => {
		const h = harness(svc.service, ["In Progress", "SDM-1", "Send to agent", "implement the criteria"]);
		await h.run();
		const [prompt, options] = h.pi.sendUserMessage.mock.calls[0] as unknown as [string, unknown];
		expect(prompt).toMatch(/^implement the criteria\n\n<jira-ticket key="SDM-1">\n# SDM-1: Summary SDM-1/);
		expect(prompt).toContain("</jira-ticket>");
		expect(options).toBeUndefined();
	});

	it("when the agent is busy it is queued as followUp; empty = analyze", async () => {
		const h = harness(svc.service, ["Send to agent", ""], { idle: false });
		await h.run("sdm-2");
		const [prompt, options] = h.pi.sendUserMessage.mock.calls[0] as unknown as [string, unknown];
		expect(prompt).toMatch(/^Analyze ticket SDM-2/);
		expect(options).toEqual({ deliverAs: "followUp" });
	});

	it("cancelling the instruction returns to the action menu", async () => {
		const h = harness(svc.service, ["Send to agent", undefined, undefined], {});
		await h.run("SDM-1");
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("transition asks for confirmation with from → to and returns to actions", async () => {
		const h = harness(svc.service, ["Transition", "Selected for Development", true, undefined]);
		await h.run("SDM-1");
		expect(h.log).toContain("confirm Move SDM-1? In Progress → In Prioritization");
		expect(svc.source.calls).toContain("transition:SDM-1:21");
		expect(h.ui.notify).toHaveBeenCalledWith("SDM-1: In Progress → In Prioritization", "info");
	});

	it("a declined transition does not write", async () => {
		const h = harness(svc.service, ["Transition", "In Review", false, undefined]);
		await h.run("SDM-1");
		expect(svc.source.calls.some((c) => c.startsWith("transition:"))).toBe(false);
	});

	it("comment uses the editor and confirms; empty does nothing", async () => {
		const h = harness(svc.service, ["Comment", "  ready for review  ", true, "Comment", "   ", undefined]);
		await h.run("SDM-1");
		expect(svc.source.calls.filter((c) => c.startsWith("comment:"))).toEqual(["comment:SDM-1:ready for review"]);
	});

	it("readonly hides the write actions", async () => {
		const ro = makeService({ writeMode: "readonly" });
		const h = harness(ro.service, [undefined]);
		await h.run("SDM-1");
		expect(h.log[0]).not.toContain("Transition");
		expect(h.log[0]).not.toContain("Comment");
	});

	it("view details adds the ticket to the context without starting a turn", async () => {
		const h = harness(svc.service, ["View details"]);
		await h.run("SDM-1");
		const [message, options] = h.pi.sendMessage.mock.calls[0] as unknown as [any, unknown];
		expect(message).toMatchObject({ customType: TICKET_MESSAGE, display: true, details: { key: "SDM-1" } });
		expect(message.content).toMatch(/^<jira-ticket key="SDM-1">\n# SDM-1: Summary SDM-1[\s\S]*<\/jira-ticket>$/);
		expect(options).toBeUndefined();
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.ui.notify).toHaveBeenCalledWith("SDM-1 added to the agent context", "info");
	});

	it("view details while the agent is busy delivers it on the next turn", async () => {
		const h = harness(svc.service, ["View details"], { idle: false });
		await h.run("SDM-1");
		expect(h.pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "nextTurn" });
	});

	it("open and copy", async () => {
		const h = harness(svc.service, ["Open in browser"]);
		await h.run("SDM-1");
		expect(h.pi.exec).toHaveBeenCalledWith(expect.any(String), ["https://jira/browse/SDM-1"]);
		const h2 = harness(svc.service, ["Copy key"]);
		await h2.run("SDM-1");
		expect(copyToClipboard).toHaveBeenCalledWith("SDM-1");
	});

	it("Back from ticket returns to statuses", async () => {
		const h = harness(svc.service, ["Backlog", "← Back", undefined]);
		await h.run();
		expect(h.log.map((l) => l.split(" [")[0])).toEqual([
			"select SDM Sprint 130 · status",
			"select Ticket",
			"select SDM Sprint 130 · status",
		]);
	});

	it("without UI no menus are opened", async () => {
		const h = harness(svc.service, [], { hasUI: false });
		await h.run();
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("needs an interactive UI"), "error");
	});

	it("API errors are notified", async () => {
		svc.source.getIssue = async () => {
			throw new Error("GET /x → 401: invalid credentials or expired PAT");
		};
		const h = harness(svc.service, []);
		await h.run("SDM-9");
		expect(h.ui.notify).toHaveBeenCalledWith("Jira: GET /x → 401: invalid credentials or expired PAT", "error");
	});

	it("autocompletes subcommands and known keys", async () => {
		const h = harness(svc.service, []);
		await svc.service.listMine("SDM");
		expect(h.command.getArgumentCompletions("sdm-").map((i: any) => i.value)).toEqual(["SDM-1", "SDM-2"]);
		expect(h.command.getArgumentCompletions("re").map((i: any) => i.value)).toEqual(["refresh", "reload"]);
		expect(h.command.getArgumentCompletions("zzz")).toBeNull();
	});
});
