/**
 * Discovers the customfields (Sprint, Story Points, Acceptance criteria) and
 * measures which ones are filled in the project's active-sprint tickets.
 *
 *   pnpm discover            # uses projects[0]
 *   pnpm discover SDM
 */
import { loadConfig } from "../src/config.ts";
import { JiraDcSource } from "../src/source/jira-dc.ts";

interface Field {
	id: string;
	name: string;
	custom: boolean;
	schema?: { type?: string; custom?: string };
}

const KINDS = {
	sprint: (f: Field) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint",
	storyPoints: (f: Field) =>
		f.schema?.type === "number" && /story.?point|puntos|estimat|estimaci/i.test(f.name),
	acceptanceCriteria: (f: Field) => /acceptance|aceptaci|criterio/i.test(f.name),
} as const;

try {
	const { config, sources } = loadConfig(process.cwd());
	const project = (process.argv[2] ?? config.projects[0]).toUpperCase();
	const jira = new JiraDcSource(config);

	console.log(`Config: ${sources.join(", ")}`);
	const me = await jira.whoami();
	console.log(`Authenticated as ${me.displayName} (${me.name})\n`);

	const fields = await jira.request<Field[]>("GET", config.endpoints.fields);
	const candidates = Object.fromEntries(
		Object.entries(KINDS).map(([kind, test]) => [kind, fields.filter((f) => f.custom && test(f))]),
	) as Record<keyof typeof KINDS, Field[]>;

	const ids = Object.values(candidates).flat().map((f) => f.id);
	const sample = await jira.request<{ total: number; issues: { fields: Record<string, unknown> }[] }>(
		"POST",
		config.endpoints.search,
		{ jql: `project = ${project} AND sprint in openSprints()`, maxResults: 100, fields: ids },
	);
	const filled = (id: string) =>
		sample.issues.filter((i) => {
			const v = i.fields[id];
			return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
		}).length;

	console.log(`Sample: ${sample.issues.length} of ${sample.total} tickets in ${project}'s active sprint\n`);
	const suggestion: Record<string, string> = {};
	for (const [kind, list] of Object.entries(candidates)) {
		console.log(`${kind}:`);
		if (list.length === 0) console.log("  (no candidates)");
		const ranked = list.map((f) => ({ f, n: filled(f.id) })).sort((a, b) => b.n - a.n);
		for (const { f, n } of ranked) console.log(`  ${f.id.padEnd(20)} ${String(n).padStart(3)} filled  ${f.name}`);
		if (ranked[0]?.n) suggestion[kind] = ranked[0].f.id;
		console.log();
	}
	console.log(`Suggested jira.json:\n${JSON.stringify({ fields: suggestion }, null, 2)}`);
} catch (err) {
	// Config/HTTP errors already carry a clear message; the stack adds nothing.
	console.error(`✗ ${(err as Error).message}`);
	process.exitCode = 1;
}
