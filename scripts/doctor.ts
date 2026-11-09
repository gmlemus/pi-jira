/**
 * Checks the config against real Jira and shows your sprint tickets by status.
 *
 *   pnpm doctor              # details of the first ticket found
 *   pnpm doctor SDM-123      # details of that ticket
 */
import { loadConfig } from "../src/config.ts";
import { JiraDcSource } from "../src/source/jira-dc.ts";

try {
	const { config, sources } = loadConfig(process.cwd());
	const jira = new JiraDcSource(config);

	console.log(`Config: ${sources.join(", ")}`);
	const me = await jira.whoami();
	console.log(`Authenticated as ${me.displayName} (${me.name})`);

	let first: string | undefined;
	for (const project of config.projects) {
		const tickets = await jira.listMySprintIssues(project);
		console.log(`\n${project} · ${tickets[0]?.sprint ?? "no sprint"} · ${tickets.length} assigned to you`);
		first ??= tickets[0]?.key;
		const byStatus = Map.groupBy(tickets, (t) => t.status);
		for (const [status, list] of byStatus) {
			console.log(`  ${status} (${list.length})`);
			for (const t of list) console.log(`    ${t.key.padEnd(10)} ${String(t.storyPoints ?? "-").padStart(3)}p  ${t.summary}`);
		}
	}

	const key = process.argv[2] ?? first;
	if (key) {
		const d = await jira.getIssue(key);
		const transitions = await jira.getTransitions(key);
		console.log(`\n${d.key} · ${d.type} · ${d.status} · ${d.priority}`);
		console.log(`  ${d.summary}`);
		console.log(`  sprint: ${d.sprint} · sp: ${d.storyPoints ?? "-"} · labels: ${d.labels.join(", ") || "-"}`);
		console.log(`  description: ${d.description?.length ?? 0} chars · criteria: ${d.acceptanceCriteria?.length ?? 0} chars`);
		console.log(`  subtasks: ${d.subtasks.length} · links: ${d.links.length} · comments: ${d.comments.length}`);
		console.log(`  transitions: ${transitions.map((t) => `${t.name} → ${t.to}`).join(" | ") || "-"}`);
	}
} catch (err) {
	// Config/HTTP errors already carry a clear message; the stack adds nothing.
	console.error(`✗ ${(err as Error).message}`);
	process.exitCode = 1;
}
