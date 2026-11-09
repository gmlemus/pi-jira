import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { registerJiraCommand, TICKET_MESSAGE, type TicketMessageDetails } from "./command.ts";
import { loadConfig } from "./config.ts";
import { JiraService } from "./service.ts";
import { JiraDcSource } from "./source/jira-dc.ts";
import { registerJiraTools } from "./tools.ts";

const PREVIEW_LINES = 14;

export default function (pi: ExtensionAPI) {
	let service: JiraService | undefined;

	/** Config is loaded lazily and reloaded with `/jira reload`. */
	function getService(cwd: string): JiraService {
		if (!service) {
			const loaded = loadConfig(cwd);
			service = new JiraService(loaded, new JiraDcSource(loaded.config));
		}
		return service;
	}

	registerJiraCommand(pi, {
		service: getService,
		current: () => service,
		reset: () => {
			service = undefined;
		},
	});

	registerJiraTools(pi, getService);

	// Ticket added with "View details": the model receives `content`; this only decides how it looks.
	pi.registerMessageRenderer<TicketMessageDetails>(TICKET_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const data = message.details;
		if (!data) return undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", `[jira] ${data.key} · in agent context`), 0, 0));
		const lines = data.markdown.split("\n");
		const preview = expanded || lines.length <= PREVIEW_LINES ? data.markdown : lines.slice(0, PREVIEW_LINES).join("\n");
		box.addChild(new Markdown(preview, 0, 0, getMarkdownTheme()));
		if (preview !== data.markdown) {
			box.addChild(new Text(theme.fg("dim", `… ${lines.length - PREVIEW_LINES} more lines (expand to see all)`), 0, 0));
		}
		return box;
	});
}
