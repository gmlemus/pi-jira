import type { JiraConfig } from "../config.ts";
import {
	describeTransitions,
	findTransition,
	type Ticket,
	type TicketComment,
	type TicketDetail,
	type TicketLink,
	type TicketSource,
	type Transition,
} from "./types.ts";

export class JiraHttpError extends Error {
	readonly status: number;
	readonly url: string;

	constructor(message: string, status: number, url: string) {
		super(message);
		this.status = status;
		this.url = url;
	}
}

type Fetch = typeof fetch;
type Json = Record<string, any>;

const BASE_FIELDS = ["summary", "status", "issuetype", "priority", "updated"];
const DETAIL_FIELDS = [
	...BASE_FIELDS,
	"description",
	"labels",
	"components",
	"assignee",
	"reporter",
	"parent",
	"subtasks",
	"issuelinks",
	"comment",
];

/** Adapter for Jira Server / Data Center (REST v2). */
export class JiraDcSource implements TicketSource {
	private readonly cfg: JiraConfig;
	private readonly fetchImpl: Fetch;

	constructor(cfg: JiraConfig, fetchImpl: Fetch = fetch) {
		this.cfg = cfg;
		this.fetchImpl = fetchImpl;
	}

	async whoami(signal?: AbortSignal) {
		const me = await this.request<Json>("GET", this.cfg.endpoints.myself, undefined, signal);
		return { name: String(me.name ?? me.key ?? ""), displayName: String(me.displayName ?? me.name ?? "") };
	}

	async listMySprintIssues(project: string, signal?: AbortSignal): Promise<Ticket[]> {
		const jql = this.cfg.jql.replaceAll("{project}", quoteJql(project));
		const fields = [...BASE_FIELDS, ...this.customFieldIds()];
		const out: Ticket[] = [];
		for (let startAt = 0; ; ) {
			const page = await this.request<Json>(
				"POST",
				this.cfg.endpoints.search,
				{ jql, startAt, maxResults: this.cfg.pageSize, fields },
				signal,
			);
			const issues: Json[] = page.issues ?? [];
			out.push(...issues.map((i) => this.toTicket(i)));
			startAt += issues.length;
			if (issues.length === 0 || startAt >= (page.total ?? 0)) break;
		}
		return out;
	}

	async getIssue(key: string, signal?: AbortSignal): Promise<TicketDetail> {
		const fields = [...DETAIL_FIELDS, ...this.customFieldIds()].join(",");
		const issue = await this.request<Json>("GET", `${this.path("issue", key)}?fields=${fields}`, undefined, signal);
		const f = issue.fields ?? {};
		const acId = this.cfg.fields.acceptanceCriteria;
		return {
			...this.toTicket(issue),
			description: f.description ?? undefined,
			acceptanceCriteria: acId ? (textOf(f[acId]) ?? undefined) : undefined,
			labels: f.labels ?? [],
			components: (f.components ?? []).map((c: Json) => c.name),
			assignee: f.assignee?.displayName,
			reporter: f.reporter?.displayName,
			parent: f.parent?.key,
			subtasks: (f.subtasks ?? []).map((s: Json) => linkOf("subtask", s)),
			links: (f.issuelinks ?? []).flatMap((l: Json): TicketLink[] => {
				if (l.outwardIssue) return [linkOf(l.type?.outward ?? "relates to", l.outwardIssue)];
				if (l.inwardIssue) return [linkOf(l.type?.inward ?? "relates to", l.inwardIssue)];
				return [];
			}),
			comments: (f.comment?.comments ?? []).map(
				(c: Json): TicketComment => ({
					author: c.author?.displayName ?? "?",
					created: c.created,
					body: c.body ?? "",
				}),
			),
		};
	}

	async getTransitions(key: string, signal?: AbortSignal): Promise<Transition[]> {
		const res = await this.request<Json>("GET", this.path("transitions", key), undefined, signal);
		return (res.transitions ?? []).map((t: Json) => ({ id: String(t.id), name: t.name, to: t.to?.name ?? t.name }));
	}

	async transition(key: string, to: string, signal?: AbortSignal): Promise<Transition> {
		const available = await this.getTransitions(key, signal);
		const match = findTransition(available, to);
		if (!match) throw new Error(`${key}: no transition to "${to}". Available: ${describeTransitions(available)}`);
		await this.request("POST", this.path("transitions", key), { transition: { id: match.id } }, signal);
		return match;
	}

	async addComment(key: string, body: string, signal?: AbortSignal): Promise<void> {
		await this.request("POST", this.path("comment", key), { body }, signal);
	}

	/** Raw access for field discovery and diagnostics. */
	async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const url = `${this.cfg.baseUrl}${path}`;
		const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: this.authHeader(),
			...this.cfg.headers,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";

		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (err) {
			if (timeout.aborted) throw new JiraHttpError(`Timeout (${this.cfg.timeoutMs} ms) on ${method} ${path}`, 0, url);
			const cause = (err as { cause?: { code?: string } }).cause?.code;
			throw new JiraHttpError(`Could not connect to ${this.cfg.baseUrl}${cause ? ` (${cause})` : ""}`, 0, url);
		}

		if (res.status === 204) return undefined as T;
		const text = await res.text();
		if (!res.ok) throw new JiraHttpError(describeError(res, text, method, path), res.status, url);
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new JiraHttpError(`Non-JSON response on ${method} ${path} (SSO login page or proxy?)`, res.status, url);
		}
	}

	private toTicket(issue: Json): Ticket {
		const f = issue.fields ?? {};
		const spId = this.cfg.fields.storyPoints;
		const sprintId = this.cfg.fields.sprint;
		const sp = spId ? f[spId] : undefined;
		return {
			key: issue.key,
			summary: f.summary ?? "",
			status: f.status?.name ?? "?",
			statusCategory: f.status?.statusCategory?.key ?? "",
			type: f.issuetype?.name,
			priority: f.priority?.name,
			storyPoints: typeof sp === "number" ? sp : undefined,
			sprint: sprintId ? sprintName(f[sprintId]) : undefined,
			updated: f.updated,
			url: `${this.cfg.baseUrl}/browse/${issue.key}`,
		};
	}

	private customFieldIds(): string[] {
		return Object.values(this.cfg.fields).filter((v): v is string => !!v);
	}

	private path(endpoint: "issue" | "transitions" | "comment", key: string): string {
		return this.cfg.endpoints[endpoint].replaceAll("{key}", encodeURIComponent(key));
	}

	private authHeader(): string {
		const a = this.cfg.auth;
		return a.type === "bearer"
			? `Bearer ${a.token}`
			: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString("base64")}`;
	}
}

function describeError(res: Response, text: string, method: string, path: string): string {
	let detail = "";
	try {
		const j = JSON.parse(text) as Json;
		detail = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ");
	} catch {
		/* non-JSON body */
	}
	const prefix = `${method} ${path} → ${res.status}`;
	switch (res.status) {
		case 401:
			return `${prefix}: invalid credentials or expired PAT`;
		case 403:
			return res.headers.get("x-seraph-loginreason")?.includes("CAPTCHA")
				? `${prefix}: Jira requires a CAPTCHA; log in once in the browser`
				: `${prefix}: forbidden${detail ? ` (${detail})` : ""}`;
		case 404:
			return `${prefix}: not found${detail ? ` (${detail})` : ""}`;
		default:
			return `${prefix}${detail ? `: ${detail}` : ""}`;
	}
}

/** DC returns the sprint as an object or as a string `...Sprint@x[id=1,state=ACTIVE,name=Foo,...]`. */
export function sprintName(value: unknown): string | undefined {
	const list = Array.isArray(value) ? value : value == null ? [] : [value];
	const parsed = list.map((s) => {
		if (typeof s === "object" && s) return { name: (s as Json).name as string, state: String((s as Json).state ?? "") };
		const str = String(s);
		return { name: /name=([^,\]]*)/.exec(str)?.[1], state: /state=([^,\]]*)/.exec(str)?.[1] ?? "" };
	});
	const active = parsed.find((s) => s.state.toUpperCase() === "ACTIVE");
	return (active ?? parsed.at(-1))?.name || undefined;
}

function textOf(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === "string") return v;
	if (typeof v === "object" && "value" in (v as Json)) return String((v as Json).value);
	return JSON.stringify(v);
}

function linkOf(type: string, i: Json): TicketLink {
	return { type, key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name };
}

function quoteJql(s: string): string {
	return /^[A-Za-z0-9_]+$/.test(s) ? s : `"${s.replace(/["\\]/g, "\\$&")}"`;
}
