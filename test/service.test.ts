import { describe, expect, it } from "vitest";
import { makeService } from "./fakes.ts";

describe("JiraService", () => {
	it("caches listings and details; transitioning invalidates both", async () => {
		const { source, service } = makeService();
		await service.listMine("SDM");
		await service.listMine("SDM");
		await service.getIssue("sdm-1");
		await service.getIssue("SDM-1");
		expect(source.calls).toEqual(["list:SDM", "get:SDM-1"]);

		await service.transition("SDM-1", "11");
		await service.listMine("SDM");
		await service.getIssue("SDM-1");
		expect(source.calls.slice(2)).toEqual(["transition:SDM-1:11", "list:SDM", "get:SDM-1"]);
	});

	it("commenting invalidates only the details", async () => {
		const { source, service } = makeService();
		await service.listMine("SDM");
		await service.getIssue("SDM-1");
		await service.addComment("SDM-1", "hello");
		await service.listMine("SDM");
		await service.getIssue("SDM-1");
		expect(source.calls).toEqual(["list:SDM", "get:SDM-1", "comment:SDM-1:hello", "get:SDM-1"]);
	});

	it("remembers listed keys for autocompletion", async () => {
		const { service } = makeService();
		expect(service.knownTickets()).toEqual([]);
		await service.listMine("SDM");
		expect(service.knownTickets().map((t) => t.key)).toEqual(["SDM-1", "SDM-2"]);
	});

	it("readonly writeMode blocks writes without calling the API", async () => {
		const { source, service } = makeService({ writeMode: "readonly" });
		await expect(service.transition("SDM-1", "11")).rejects.toThrow(/read-only/);
		await expect(service.addComment("SDM-1", "x")).rejects.toThrow(/read-only/);
		expect(source.calls).toEqual([]);
	});

	it("a network failure is not cached: it works once the connection is back", async () => {
		const { source, service } = makeService();
		const real = source.listMySprintIssues.bind(source);
		source.listMySprintIssues = async () => {
			throw new Error("Could not connect to https://jira (ENOTFOUND)");
		};
		await expect(service.listMine("SDM")).rejects.toThrow(/ENOTFOUND/);
		source.listMySprintIssues = real;
		expect((await service.listMine("SDM")).length).toBe(2);
	});
});
