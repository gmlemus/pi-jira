import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WriteMode = "readonly" | "confirm";

export interface JiraConfig {
	provider: "jira-dc";
	baseUrl: string;
	/** With `tokenCommand` the PAT is read at load time by running a command (e.g. the macOS keychain). */
	auth: { type: "bearer"; token: string; tokenCommand?: string } | { type: "basic"; user: string; password: string };
	/** Extra headers (gateways, corporate proxies). */
	headers: Record<string, string>;
	projects: string[];
	/** JQL with `{project}` as placeholder. */
	jql: string;
	statusOrder: string[];
	/** Customfield IDs; they vary per instance (see `pnpm discover`). */
	fields: { storyPoints?: string; sprint?: string; acceptanceCriteria?: string };
	/** REST paths; `{key}` is substituted. Override them when a gateway uses other prefixes. */
	endpoints: {
		myself: string;
		search: string;
		issue: string;
		transitions: string;
		comment: string;
		fields: string;
	};
	timeoutMs: number;
	cacheTtlSec: number;
	pageSize: number;
	writeMode: WriteMode;
}

export const DEFAULTS: Omit<JiraConfig, "baseUrl" | "auth" | "projects"> = {
	provider: "jira-dc",
	headers: {},
	jql: "assignee = currentUser() AND sprint in openSprints() AND project = {project} ORDER BY Rank ASC",
	statusOrder: [],
	fields: {},
	endpoints: {
		myself: "/rest/api/2/myself",
		search: "/rest/api/2/search",
		issue: "/rest/api/2/issue/{key}",
		transitions: "/rest/api/2/issue/{key}/transitions",
		comment: "/rest/api/2/issue/{key}/comment",
		fields: "/rest/api/2/field",
	},
	timeoutMs: 15_000,
	cacheTtlSec: 60,
	pageSize: 50,
	writeMode: "confirm",
};

export class ConfigError extends Error {}

export interface LoadedConfig {
	config: JiraConfig;
	/** Files that were merged, in increasing precedence. */
	sources: string[];
}

export function configPaths(cwd: string, home = homedir()): string[] {
	return [join(home, ".pi", "agent", "jira.json"), join(cwd, ".pi", "jira.json")];
}

/** Runs a shell command and returns its stdout; injectable for tests. */
export type RunCommand = (command: string) => string;

const runShell: RunCommand = (command) =>
	execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });

/** Merges global and project config, expands `${VAR}` and validates. */
export function loadConfig(
	cwd: string,
	opts: { home?: string; env?: NodeJS.ProcessEnv; runCommand?: RunCommand } = {},
): LoadedConfig {
	const env = opts.env ?? process.env;
	const sources: string[] = [];
	let merged: Record<string, unknown> = {};
	for (const path of configPaths(cwd, opts.home)) {
		if (!existsSync(path)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (err) {
			throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
		}
		if (!isPlainObject(parsed)) throw new ConfigError(`${path}: expected a JSON object`);
		merged = deepMerge(merged, parsed);
		sources.push(path);
	}
	if (sources.length === 0) {
		throw new ConfigError(`No configuration found. Create ${configPaths(cwd, opts.home)[0]} (see jira.example.json).`);
	}
	return { config: resolveConfig(merged, env, opts.runCommand), sources };
}

export function resolveConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv, runCommand = runShell): JiraConfig {
	const expanded = expandEnv(raw, env) as Record<string, unknown>;
	const cfg = deepMerge(DEFAULTS as unknown as Record<string, unknown>, expanded) as unknown as JiraConfig;

	const problems: string[] = [];
	if (cfg.provider !== "jira-dc") problems.push(`provider "${cfg.provider}" is not supported (use "jira-dc")`);
	if (typeof cfg.baseUrl !== "string" || !/^https?:\/\//.test(cfg.baseUrl)) problems.push("baseUrl must be an http(s) URL");
	if (!Array.isArray(cfg.projects) || cfg.projects.length === 0) problems.push("projects must contain at least one key");
	if (!cfg.jql.includes("{project}")) problems.push("jql must contain {project}");
	if (cfg.writeMode !== "readonly" && cfg.writeMode !== "confirm") problems.push('writeMode must be "readonly" or "confirm"');
	const auth = cfg.auth as Partial<{ type: string; token: string; tokenCommand: string; user: string; password: string }> | undefined;
	if (!auth) problems.push("auth is missing");
	else if (auth.type === "bearer" && auth.token && auth.tokenCommand) problems.push("use auth.token or auth.tokenCommand, not both");
	else if (auth.type === "bearer" && !auth.token && !auth.tokenCommand) problems.push("auth.token or auth.tokenCommand is missing");
	else if (auth.type === "basic" && (!auth.user || !auth.password)) problems.push("auth.user/auth.password are empty");
	else if (auth.type !== "bearer" && auth.type !== "basic") problems.push('auth.type must be "bearer" or "basic"');
	if (problems.length) throw new ConfigError(`Invalid configuration:\n- ${problems.join("\n- ")}`);

	if (cfg.auth.type === "bearer" && cfg.auth.tokenCommand) cfg.auth.token = tokenFromCommand(cfg.auth.tokenCommand, runCommand);
	cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
	cfg.projects = cfg.projects.map((p) => p.toUpperCase());
	return cfg;
}

function tokenFromCommand(command: string, run: RunCommand): string {
	let out: string;
	try {
		out = run(command);
	} catch (err) {
		// stderr can help ("item not found"); stdout is never included since it could be the token.
		const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
		throw new ConfigError(`auth.tokenCommand failed${stderr ? `: ${stderr}` : ""}`);
	}
	const token = out.trim();
	if (!token) throw new ConfigError("auth.tokenCommand returned nothing");
	return token;
}

function expandEnv(value: unknown, env: NodeJS.ProcessEnv, path = ""): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
			const v = env[name];
			if (v === undefined || v === "") throw new ConfigError(`Environment variable ${name} is not set (used in ${path || "config"})`);
			return v;
		});
	}
	if (Array.isArray(value)) return value.map((v, i) => expandEnv(v, env, `${path}[${i}]`));
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env, path ? `${path}.${k}` : k)]));
	}
	return value;
}

/** Objects are merged; arrays and scalars are replaced. */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) {
		out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
	}
	return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
