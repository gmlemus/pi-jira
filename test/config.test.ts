import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

function setup(global?: object, project?: object) {
	const root = mkdtempSync(join(tmpdir(), "pi-jira-"));
	const home = join(root, "home");
	const cwd = join(root, "repo");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (global) writeFileSync(join(home, ".pi", "agent", "jira.json"), JSON.stringify(global));
	if (project) writeFileSync(join(cwd, ".pi", "jira.json"), JSON.stringify(project));
	return { home, cwd };
}

const base = {
	baseUrl: "https://jira.example.com/",
	auth: { type: "bearer", token: "${JIRA_PAT}" },
	projects: ["sdm"],
};

describe("loadConfig", () => {
	it("applies defaults, expands env and normalizes", () => {
		const { home, cwd } = setup(base);
		const { config, sources } = loadConfig(cwd, { home, env: { JIRA_PAT: "secret" } });
		expect(sources).toHaveLength(1);
		expect(config.auth).toEqual({ type: "bearer", token: "secret" });
		expect(config.baseUrl).toBe("https://jira.example.com");
		expect(config.projects).toEqual(["SDM"]);
		expect(config.endpoints.search).toBe("/rest/api/2/search");
		expect(config.writeMode).toBe("confirm");
	});

	it("project config merges objects and replaces arrays", () => {
		const { home, cwd } = setup(
			{ ...base, fields: { sprint: "customfield_1" } },
			{ projects: ["ABC"], fields: { storyPoints: "customfield_2" }, endpoints: { search: "/gw/search" } },
		);
		const { config, sources } = loadConfig(cwd, { home, env: { JIRA_PAT: "x" } });
		expect(sources).toHaveLength(2);
		expect(config.projects).toEqual(["ABC"]);
		expect(config.fields).toEqual({ sprint: "customfield_1", storyPoints: "customfield_2" });
		expect(config.endpoints.search).toBe("/gw/search");
		expect(config.endpoints.issue).toBe("/rest/api/2/issue/{key}");
	});

	it("fails when an environment variable is missing", () => {
		const { home, cwd } = setup(base);
		expect(() => loadConfig(cwd, { home, env: {} })).toThrow(/JIRA_PAT is not set \(used in auth.token\)/);
	});

	it("lists every validation problem", () => {
		const { home, cwd } = setup({ baseUrl: "jira", auth: { type: "oauth" }, projects: [], jql: "x" });
		try {
			loadConfig(cwd, { home, env: {} });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			const msg = (err as Error).message;
			for (const s of ["baseUrl", "projects", "{project}", "auth.type"]) expect(msg).toContain(s);
		}
	});

	it("without files, says where to create the config", () => {
		const { home, cwd } = setup();
		expect(() => loadConfig(cwd, { home })).toThrow(/No configuration found/);
	});
});

describe("auth.tokenCommand", () => {
	const withCommand = { ...base, auth: { type: "bearer", tokenCommand: "get-token" } };

	it("reads the token from the command, without env vars", () => {
		const { home, cwd } = setup(withCommand);
		const run = (cmd: string) => (cmd === "get-token" ? "abc123\n" : "");
		const { config } = loadConfig(cwd, { home, env: {}, runCommand: run });
		expect(config.auth).toEqual({ type: "bearer", tokenCommand: "get-token", token: "abc123" });
	});

	it("clear errors without leaking stdout", () => {
		const { home, cwd } = setup(withCommand);
		const failing = () => {
			throw Object.assign(new Error("exit 44"), { stderr: "item not found\n", stdout: "secret" });
		};
		expect(() => loadConfig(cwd, { home, runCommand: failing })).toThrow("auth.tokenCommand failed: item not found");
		expect(() => loadConfig(cwd, { home, runCommand: () => "  \n" })).toThrow(/returned nothing/);
	});

	it("with the real shell", () => {
		const { home, cwd } = setup({ ...base, auth: { type: "bearer", tokenCommand: "printf ' tok '" } });
		expect(loadConfig(cwd, { home }).config.auth).toMatchObject({ token: "tok" });
	});

	it("token and tokenCommand together is an error", () => {
		const { home, cwd } = setup({ ...base, auth: { type: "bearer", token: "x", tokenCommand: "y" } });
		expect(() => loadConfig(cwd, { home })).toThrow(/not both/);
	});
});
