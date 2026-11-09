import { describe, expect, it } from "vitest";
import { type JiraConfig, resolveConfig } from "../src/config.ts";
import { TtlCache } from "../src/source/cache.ts";
import { JiraDcSource, JiraHttpError, sprintName } from "../src/source/jira-dc.ts";

const cfg: JiraConfig = resolveConfig(
	{
		baseUrl: "https://jira.example.com",
		auth: { type: "bearer", token: "pat" },
		projects: ["SDM"],
		fields: { sprint: "customfield_10100", storyPoints: "customfield_10200", acceptanceCriteria: "customfield_10300" },
		pageSize: 2,
	},
	{},
);

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: any;
}

function mockFetch(handler: (c: Call) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }) {
	const calls: Call[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		const call: Call = {
			method: init.method ?? "GET",
			url,
			headers: init.headers as Record<string, string>,
			body: init.body ? JSON.parse(init.body as string) : undefined,
		};
		calls.push(call);
		const r = handler(call);
		const status = r.status ?? 200;
		const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
		return new Response(status === 204 ? null : body, { status, headers: r.headers });
	}) as typeof fetch;
	return { impl, calls };
}

const issue = (key: string, extra: Record<string, unknown> = {}) => ({
	key,
	fields: {
		summary: `Summary ${key}`,
		status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
		issuetype: { name: "Story" },
		priority: { name: "High" },
		customfield_10200: 3,
		customfield_10100: [
			"com.atlassian.greenhopper.service.sprint.Sprint@1a[id=1,rapidViewId=2,state=CLOSED,name=SDM 41,startDate=x]",
			"com.atlassian.greenhopper.service.sprint.Sprint@1b[id=2,rapidViewId=2,state=ACTIVE,name=SDM 42,startDate=x]",
		],
		...extra,
	},
});

describe("JiraDcSource", () => {
	it("paginates the search, substitutes {project} and maps fields", async () => {
		const { impl, calls } = mockFetch(({ body }) =>
			body.startAt === 0
				? { json: { total: 3, issues: [issue("SDM-1"), issue("SDM-2")] } }
				: { json: { total: 3, issues: [issue("SDM-3")] } },
		);
		const tickets = await new JiraDcSource(cfg, impl).listMySprintIssues("SDM");

		expect(calls).toHaveLength(2);
		expect(calls[0].url).toBe("https://jira.example.com/rest/api/2/search");
		expect(calls[0].headers.Authorization).toBe("Bearer pat");
		expect(calls[0].body.jql).toContain("project = SDM ORDER BY");
		expect(calls[0].body.fields).toEqual(expect.arrayContaining(["summary", "customfield_10100", "customfield_10200"]));
		expect(calls[1].body.startAt).toBe(2);
		expect(tickets.map((t) => t.key)).toEqual(["SDM-1", "SDM-2", "SDM-3"]);
		expect(tickets[0]).toMatchObject({
			status: "In Progress",
			statusCategory: "indeterminate",
			storyPoints: 3,
			sprint: "SDM 42",
			url: "https://jira.example.com/browse/SDM-1",
		});
	});

	it("getIssue maps details, comments, links and criteria", async () => {
		const { impl, calls } = mockFetch(() => ({
			json: issue("SDM-7", {
				description: "h2. Context",
				customfield_10300: "* must X",
				labels: ["backend"],
				components: [{ name: "API" }],
				assignee: { displayName: "Ann" },
				subtasks: [{ key: "SDM-8", fields: { summary: "sub", status: { name: "To Do" } } }],
				issuelinks: [{ type: { outward: "blocks", inward: "is blocked by" }, inwardIssue: { key: "SDM-2" } }],
				comment: { comments: [{ author: { displayName: "Leo" }, created: "2026-11-01", body: "ok" }] },
			}),
		}));
		const d = await new JiraDcSource(cfg, impl).getIssue("SDM-7");
		expect(calls[0].url).toMatch(/\/rest\/api\/2\/issue\/SDM-7\?fields=.*description.*customfield_10300/);
		expect(d).toMatchObject({
			description: "h2. Context",
			acceptanceCriteria: "* must X",
			components: ["API"],
			assignee: "Ann",
			subtasks: [{ type: "subtask", key: "SDM-8", status: "To Do" }],
			links: [{ type: "is blocked by", key: "SDM-2" }],
			comments: [{ author: "Leo", body: "ok" }],
		});
	});

	it("transition resolves by target status name", async () => {
		const { impl, calls } = mockFetch(({ method }) =>
			method === "GET"
				? { json: { transitions: [{ id: "21", name: "Start", to: { name: "In Progress" } }, { id: "31", name: "Send to review", to: { name: "Code Review" } }] } }
				: { status: 204 },
		);
		const t = await new JiraDcSource(cfg, impl).transition("SDM-1", "code review");
		expect(t.id).toBe("31");
		expect(calls[1]).toMatchObject({ method: "POST", body: { transition: { id: "31" } } });
	});

	it("an invalid transition lists the available ones without POSTing", async () => {
		const { impl, calls } = mockFetch(() => ({ json: { transitions: [{ id: "21", name: "Start", to: { name: "In Progress" } }] } }));
		await expect(new JiraDcSource(cfg, impl).transition("SDM-1", "Done")).rejects.toThrow(/"Start" → In Progress/);
		expect(calls).toHaveLength(1);
	});

	it("addComment sends the body", async () => {
		const { impl, calls } = mockFetch(() => ({ status: 201, json: { id: "1" } }));
		await new JiraDcSource(cfg, impl).addComment("SDM-1", "hello");
		expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringMatching(/SDM-1\/comment$/), body: { body: "hello" } });
	});

	it.each([
		[401, {}, /expired PAT/],
		[403, { "X-Seraph-LoginReason": "AUTHENTICATION_DENIED_CAPTCHA" }, /CAPTCHA/],
		[400, {}, /jql: unknown field/],
	])("maps HTTP %i", async (status, headers, msg) => {
		const { impl } = mockFetch(() => ({ status, headers, json: { errorMessages: [], errors: { jql: "unknown field" } } }));
		const err = await new JiraDcSource(cfg, impl).whoami().catch((e) => e);
		expect(err).toBeInstanceOf(JiraHttpError);
		expect(err.status).toBe(status);
		expect(err.message).toMatch(msg);
	});

	it("detects SSO HTML responses", async () => {
		const { impl } = mockFetch(() => ({ text: "<html>login</html>" }));
		await expect(new JiraDcSource(cfg, impl).whoami()).rejects.toThrow(/SSO/);
	});

	it("offline: clear message with the error code", async () => {
		const offline = (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
		}) as typeof fetch;
		await expect(new JiraDcSource(cfg, offline).whoami()).rejects.toThrow(
			"Could not connect to https://jira.example.com (ENOTFOUND)",
		);
	});

	it("configurable timeout", async () => {
		const slow = resolveConfig({ ...cfg, timeoutMs: 20 }, {});
		const hang = ((_: string, init: RequestInit) =>
			new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
		await expect(new JiraDcSource(slow, hang).whoami()).rejects.toThrow("Timeout (20 ms) on GET /rest/api/2/myself");
	});

	it("auth basic", async () => {
		const basic = resolveConfig({ ...cfg, auth: { type: "basic", user: "u", password: "p" } }, {});
		const { impl, calls } = mockFetch(() => ({ json: { name: "u" } }));
		await new JiraDcSource(basic, impl).whoami();
		expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
	});
});

describe("sprintName", () => {
	it("accepts objects and prefers the active one", () => {
		expect(sprintName([{ name: "A", state: "closed" }, { name: "B", state: "active" }, { name: "C", state: "future" }])).toBe("B");
		expect(sprintName(null)).toBeUndefined();
	});
});

describe("TtlCache", () => {
	it("deduplicates, expires and does not cache errors", async () => {
		let now = 0;
		const cache = new TtlCache(1000, () => now);
		let n = 0;
		const load = async () => ++n;
		expect(await Promise.all([cache.getOrLoad("a", load), cache.getOrLoad("a", load)])).toEqual([1, 1]);
		now = 1001;
		expect(await cache.getOrLoad("a", load)).toBe(2);
		await expect(cache.getOrLoad("e", async () => Promise.reject(new Error("x")))).rejects.toThrow();
		expect(await cache.getOrLoad("e", load)).toBe(3);
		cache.invalidate();
		expect(await cache.getOrLoad("a", load)).toBe(4);
	});
});
