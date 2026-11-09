# pi-jira

A [pi](https://pi.dev) extension that shows your Jira tickets in the active sprint and lets your agents read them and, only when you ask, move or comment on them.

- `/jira`: menus for project → status → ticket → action.
- Agent tools: `jira_my_sprint`, `jira_get_issue`, `jira_transition`, `jira_comment`.
- Adapter for Jira Server / Data Center (REST v2 with a Personal Access Token), tested with DC 10.3.

## Installation

```bash
pnpm install
pi install /path/to/pi-jira     # permanent (~/.pi/agent/settings.json)
pi -e /path/to/pi-jira          # single session, handy while developing
```

Run `/reload` in pi after changing the code or the config.

## Configuration

Two files are merged, the second one taking precedence. Objects are merged and arrays are replaced.

1. `~/.pi/agent/jira.json`: global.
2. `<repo>/.pi/jira.json`: per repository (it is in `.gitignore`).

```json
{
  "provider": "jira-dc",
  "baseUrl": "https://jira.example.com",
  "auth": { "type": "bearer", "token": "${JIRA_PAT}" },
  "projects": ["SDM"],
  "statusOrder": ["In Progress", "In Review", "Blocked / On hold", "In Prioritization", "Backlog", "Done", "Cancelled"],
  "fields": {
    "sprint": "customfield_10100",
    "storyPoints": "customfield_10300",
    "acceptanceCriteria": "customfield_15680"
  },
  "writeMode": "confirm"
}
```

| Field | Default | Description |
|---|---|---|
| `baseUrl` | (required) | Jira URL, without `/rest/...` |
| `auth` | (required) | See [Credentials](#credentials) |
| `projects` | (required) | Project keys |
| `jql` | `assignee = currentUser() AND sprint in openSprints() AND project = {project} ORDER BY Rank ASC` | Must contain `{project}` |
| `statusOrder` | `[]` | Order of statuses in menus and listings; unlisted statuses go last |
| `fields` | `{}` | Customfield IDs; use `pnpm discover` |
| `writeMode` | `"confirm"` | `"confirm"` or `"readonly"` |
| `headers` | `{}` | Extra headers (gateways, proxies) |
| `endpoints` | REST v2 paths | Override paths when Jira sits behind a gateway with other prefixes; `{key}` is substituted |
| `timeoutMs` | `15000` | Per-request timeout |
| `cacheTtlSec` | `60` | Cache for listings and details; `/jira refresh` clears it |
| `pageSize` | `50` | Search page size |

Any string accepts `${VAR}`. If the variable is not set, the extension reports which field uses it.

### Credentials

Authentication uses a Personal Access Token: in Jira, Profile → Personal Access Tokens. There are two ways to give it to the extension.

**Environment variable:** `"token": "${JIRA_PAT}"`. This only works if pi starts from a shell that has the variable.

**Command:** pi runs the command when loading the config, so it does not depend on the environment. This is useful for herdr or tuios panes and for sub-agents.

```json
"auth": { "type": "bearer", "tokenCommand": "security find-generic-password -s jira-pat -w" }
```

To store the PAT in the macOS keychain:

```bash
security add-generic-password -s jira-pat -a "$USER" -w
```

There is also `{ "type": "basic", "user": "...", "password": "..." }` for instances without PATs.

### Discovering customfields

Sprint, Story Points and Acceptance criteria have different IDs on every instance, and there are often several candidates. This command lists the candidates and counts which ones are filled in the active-sprint tickets:

```bash
pnpm discover SDM
```

### Read-only per repository

```json
// <repo>/.pi/jira.json
{ "writeMode": "readonly" }
```

With this, Transition and Comment disappear from `/jira`, and the write tools fail without calling Jira.

## Usage

### `/jira`

| Command | Effect |
|---|---|
| `/jira` | Status → ticket → action (the project is only asked for when there are several) |
| `/jira SDM-123` | Straight to the ticket's actions |
| `/jira refresh` | Clears the cache and opens the menus |
| `/jira doctor` | Tests the credentials and counts tickets per project |
| `/jira reload` | Re-reads the config |

Ticket actions:

- **Send to agent:** asks for an instruction and sends it together with the full ticket. If you leave it empty, the agent analyzes the ticket.
- **View details:** shows the ticket and adds it to the agent context, which receives it with your next message.
- **Transition** and **Comment:** ask for confirmation.
- **Open in browser** and **Copy key**.

### Agent tools

| Tool | Writes | Notes |
|---|---|---|
| `jira_my_sprint` | No | Grouped by status; includes `structuredContent` for codemode |
| `jira_get_issue` | No | The ticket is wrapped in `<jira-ticket key="…">` |
| `jira_transition` | Yes | `to` accepts the target status or the transition name |
| `jira_comment` | Yes | Uses Jira wiki markup |

### Write policy

Agents only write to Jira when you ask them to, and always with your approval:

1. The tool instructions tell them to write only when your latest message asks for it for that ticket, never on their own initiative.
2. Every write opens a dialog with the exact change (`In Progress → In Review`, or the full comment text). If you decline, the tool fails and tells the agent not to retry.
3. Without a UI (`pi -p`, JSON mode or agents without a UI) writes are blocked.
4. With `writeMode: "readonly"` they are always blocked.

## Development

```bash
pnpm test        # vitest
pnpm typecheck   # tsc
pnpm discover    # customfields against real Jira
pnpm doctor      # your tickets and one ticket's details, against real Jira
```

The scripts run with Node's type-stripping mode, which is why `tsconfig` enables `erasableSyntaxOnly`.

```
src/
  index.ts           registration: command, tools and renderer
  config.ts          loading, merging, ${VAR}, tokenCommand and validation
  service.ts         cache and invalidation; shared by the command and the tools
  command.ts         /jira
  tools.ts           jira_* tools and the write policy
  format.ts          ticket → Markdown, wiki markup → Markdown
  source/types.ts    TicketSource: the contract for any backend
  source/jira-dc.ts  Jira Server/DC adapter
  source/cache.ts    TTL cache
```

To support another backend (Jira Cloud, a custom API), implement `TicketSource` and select it based on `provider`.
