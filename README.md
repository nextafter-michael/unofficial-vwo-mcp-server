# unofficial-vwo-mcp-server

An unofficial [MCP](https://modelcontextprotocol.io) server that exposes VWO platform
operations as tools an AI agent can call. Built on the MCP TypeScript SDK v2
(`@modelcontextprotocol/server`), stdio transport.

Not affiliated with or endorsed by VWO / Wingify.

New to this repo? See [GETTING-STARTED.md](GETTING-STARTED.md) for a step-by-step walkthrough
(clone, build, get a token, register with a host). This file is the deeper reference —
*why* things work the way they do.

## Tools

45 tools. Reads are unmarked; **⚠** marks a tool that mutates VWO state and carries
`REQUIRES_HUMAN_APPROVAL`, so hosts prompt a person on every call.

| Area | Tools |
| --- | --- |
| Diagnostics | `vwo_verify_connection` |
| Workspaces | `vwo_list_workspaces`, `vwo_get_workspace`, `vwo_get_workspace_history`, **⚠** `vwo_new_workspace`, `vwo_update_workspace` |
| Campaigns | `vwo_list_campaigns`, `vwo_get_campaign`, `vwo_get_campaign_share_link`, **⚠** `vwo_new_campaign`, `vwo_update_campaign`, `vwo_update_campaign_status` |
| Drafts | `vwo_list_drafts`, `vwo_get_draft`, **⚠** `vwo_update_draft_campaigns`, `vwo_delete_draft_campaigns` |
| Goals | `vwo_list_campaign_goals`, `vwo_get_campaign_goal`, **⚠** `vwo_new_campaign_goal`, `vwo_update_campaign_goal`, `vwo_delete_campaign_goal` |
| Variations | `vwo_list_campaign_variations`, `vwo_get_campaign_variation`, **⚠** `vwo_new_campaign_variation`, `vwo_update_campaign_variation`, `vwo_delete_campaign_variation` |
| Sections | `vwo_list_campaign_sections`, `vwo_get_campaign_section`, **⚠** `vwo_new_campaign_section`, `vwo_update_campaign_section`, `vwo_delete_campaign_section` |
| Metric reports | `vwo_list_metric_reports`, `vwo_get_metric_report` |
| Labels | `vwo_list_labels`, `vwo_list_campaign_labels`, **⚠** `vwo_add_campaign_label`, `vwo_delete_campaign_label` |
| Tracking code | `vwo_get_smartcode` |
| Custom widgets | `vwo_list_custom_widgets`, `vwo_get_custom_widget`, **⚠** `vwo_new_custom_widget`, `vwo_update_custom_widget`, `vwo_delete_custom_widget`, `vwo_create_custom_widgets`, `vwo_update_custom_widgets` |

Every tool name carries a `vwo_` prefix. Claude Code additionally namespaces by server
(`mcp__vwo__vwo_list_campaigns`), but the local prefix is what survives in hosts that
don't namespace, and in any text — tool descriptions, error messages — that only ever
shows the bare name.

Uses **VWO REST API v2** exclusively. v1 is retired and the base URL is validated to
end in `/v2` at startup — see [API version safety](#api-version-safety).

### Where the docs and the live API disagree

Every route was verified against the live API (a `401` proves the route exists; a `404`
proves it does not). Three cases where following the reference literally would have
produced broken or wrong tools:

| Operation | Reference says | Actual |
| --- | --- | --- |
| Update/delete a campaign goal | `/accounts/{a}/campaign/{c}/goals/{g}` — singular `campaign` | Singular **404s**. Plural `/campaigns/` is used. |
| Custom widgets | — | Served from `/changesets`, not any form of `/widgets`. |
| Update bulk custom widgets | `POST /accounts/{a}/attribute-list/{id}` | Unrelated endpoint. See caveat below. |

**`vwo_update_custom_widgets` is the one unverified endpoint.** Its doc page points at an
attribute-list endpoint that has nothing to do with widgets, and the nav lists the
operation as `GET`. This server uses `PATCH /accounts/{a}/changesets/bulk`, which exists
and is consistent with the single-widget `PATCH` and the bulk `POST`. The tool's own
description tells the agent the endpoint is inferred. Confirm the first real call.

### Collection response shapes are not consistent

VWO returns list collections in two different shapes, on the *same* endpoint depending on
parameters. Verified against the live API:

| Endpoint | `_data` shape |
| --- | --- |
| `GET /campaigns` (no `status`) | `{ partialCollection: [...], totalCount, offset }` |
| `GET /campaigns?status=…` | flat array |
| `GET /insights-metrics` | `{ partialCollection, totalCount, offset }` — and `partialCollection` is **not an array** when empty |
| `/drafts`, `/feeds`, `/goals`, `/variations`, `/accounts` | flat array |
| `/labels`, `/changesets` | `_data` omitted entirely when empty |

`_metadata` is **never present** on any of them, despite the docs implying it; the real
total lives at `_data.totalCount`, and only on the wrapped shape.

This bit hard: an earlier `listResult` handled only the flat-array case and silently
returned `[]` for the wrapped one, so a workspace holding **142 campaigns reported
`count: 0`**. `extractCollection` in [`src/tools/shared.ts`](src/tools/shared.ts) now
normalizes every shape above, and — because the failure was *silent*, which is what made
it dangerous — an unrecognized shape now surfaces a `warning` in the tool result telling
the agent to report a bug rather than conclude there is no data.

### Two more undocumented `/campaigns` behaviors

**`status` is a real query parameter that VWO does not document.** UPPERCASE only
(lowercase returns HTTP 400). Valid values, taken from the error message VWO returns for an
invalid one: `ACTIVE`, `DELETED`, `ARCHIVED`, `RUNNING`, `PAUSED`, `STOPPED`, `NOT_STARTED`.
Omitting it returns campaigns of every status — including soft-deleted ones, so check each
result's own `isDeleted` and `status` fields before reporting a campaign as live. Note
`status=ARCHIVED` returns campaigns whose own `status` field reads `STOPPED`: archived-ness
is a separate axis from the status value.

**`limit` is capped at 25 on this endpoint**, silently — `limit=50` and `limit=100` both
return 25 (while `/feeds` honors `limit=100`, so the cap is per-endpoint). The tool's schema
caps `limit` at 25 to match, because allowing a larger value broke paging: `nextOffset` is
derived partly from whether a page came back full, and a 25-item response to a `limit=100`
request looks like a final page. Verified after the fix that paging walks all 142 campaigns
across 6 pages and terminates correctly.

Two more shapes worth knowing: `vwo_update_campaign_status` is a **bulk** endpoint with no
campaign id in the path (ids go in the body), and `vwo_update_campaign` requires its payload
wrapped in a `campaigns` object — the tool adds that wrapper itself, since models
reliably get nesting like that wrong.

**Campaign `type`/`platform` values are lowercase and hyphenated, not the generic
A/B-testing names they resemble.** An early version of this server's tool descriptions
said `"AB"`, `"SPLIT_URL"`, `"MVT"`, `"FUNNEL"`, `"WEB"`, `"FULLSTACK"` — all wrong. VWO's
own `type` filter enum on `GET /campaigns` is `ab`, `multivariate` (not `mvt`), `split`
(not `split-url`), `feature-rollout`, `feature-test`, plus non-testing types (`heatmap`,
`survey`, `recording`, …); `platform` is `website`, `full-stack`, or `mobile-app`. Fixed in
[`src/tools/campaigns.ts`](src/tools/campaigns.ts) and reflected in the workflow prompts
below, which is also how `feature-rollout` was confirmed as the real type value behind
"Web Rollouts."

### Campaign-resource writes need a plural wrapper

VWO wraps every campaign-resource write body in the plural resource name. An unwrapped body is
rejected with `HTTP 400 "Request is not in desired format."` — a real failure hit while creating a
variation, not a theoretical one:

| Operation | Required body |
| --- | --- |
| `vwo_update_campaign` | `{"campaigns": {…}}` |
| `vwo_new_campaign_goal` / `vwo_update_campaign_goal` | `{"goals": {…}}` |
| `vwo_new_campaign_variation` / `vwo_update_campaign_variation` | `{"variations": {…}}` |
| `vwo_new_campaign_section` / `vwo_update_campaign_section` | `{"sections": {…}}` |

**All of these tools add the wrapper for you — pass the fields flat.** An already-wrapped body is
passed through untouched, so both forms work. The wrapper key is `spec.segment` in
[`campaignResource.ts`](src/tools/campaignResource.ts), so goals/variations/sections get it from one
place; `vwo_update_campaign` has its own.

### Variation changes: write `changes`, read `editorData`

The asymmetry here is a genuine trap. *Reading* a variation returns `editorData` — VWO's internal
op stack (`{stack: [{op: {opName: …}}]}`). Writing that same structure back is **rejected**. The
write format is a raw `changes` string, which VWO then compiles into `editorData` itself:

```jsonc
// write this
{ "name": "Variation 1", "changes": "<script>/* JS that mutates the page */</script>" }
```

Both `vwo_new_campaign_variation` and `vwo_update_campaign_variation` say so in their `body`
descriptions, and `vwo_general_guidance` repeats it, because the natural move — read the variation,
edit the structure you got, write it back — is exactly the thing that fails.

### A newly created campaign is not a valid test yet

`vwo_new_campaign` returns `status: NOT_STARTED` (a draft that serves no traffic), but it also
leaves the campaign in a state that isn't a working A/B test, and nothing in VWO's docs warns about
it:

- VWO creates **only a Control** — every other variation must be added explicitly.
- That Control comes back `isDisabled: true, percentSplit: 0`, and **adding a variation does not
  change it**. Left alone, the test has no baseline.
- The create response can report stale variation values, so read the campaign back rather than
  trusting it.

The three workflow prompts share a `POST_CREATE_VERIFY_SECTION` that walks through fixing this.

### Deleting a campaign

There is no `DELETE /campaigns/{id}` endpoint — checked the whole spec; campaigns are the one major
resource without one. Removal is a status change to `DELETED` (or `ARCHIVED`) via
`vwo_update_campaign_status`, which soft-deletes: the campaign still appears in
`vwo_list_campaigns` with `isDeleted: true` and via `status=DELETED`. So **creating a campaign is
reversible**, but deletion is treated as destructive and gated on an explicit user request. (The
prompts previously claimed creation could not be undone; that was wrong and is corrected.)

### Request bodies

VWO documents a request schema for only three write endpoints (`vwo_new_workspace`,
`vwo_update_workspace`, `vwo_new_campaign`). Those get explicit typed fields — including
`vwo_new_campaign`'s `urls` and `goals`, which are now typed from shapes confirmed by a real
successful creation rather than left as opaque arrays.

Every other write tool takes a validated `body` object passed through to VWO — rather than a strict
schema invented here that would reject valid payloads. To keep that from meaning "go read the docs
first", each `body` description carries the endpoint's doc URL **plus a concrete verified example**,
and `vwo_general_guidance` collects the common ones. The goal is that an agent never needs to fetch
VWO's reference for a routine write.

### Account listing must pass `includeCurrent`

`GET /accounts` omits the token's own main workspace unless `includeCurrent=true` is passed. This
caused a real bug: `vwo_list_workspaces` passed it and saw 43 workspaces, while the account
directory backing `workspaceName` resolution did not and saw 41 — so `workspaceName` could never
resolve the token's *own* workspace, which is the one a user is most likely to name. It failed with
"no match" plus a candidate list that conspicuously omitted it. Two different counts from the same
account is the tell. Fixed in [`accounts.ts`](src/vwo/accounts.ts).

## Prompts

Tools are *actions* an agent takes; prompts are a separate MCP primitive for guidance —
text that steers how the model approaches a situation, with no tool call attached. This
server exposes four:

| Prompt | Purpose |
| --- | --- |
| `vwo_general_guidance` | House rules that apply everywhere: resolving workspaces, what needs approval, rate limits, which workflow prompt to use, and to check VWO's own docs for platform-behavior questions. No arguments. |
| `vwo_ab_test_workflow` | Inspect → plan → apply → verify → iterate for a same-page A/B test (type `ab`/`multivariate`). |
| `vwo_split_test_workflow` | The same shape, for a Split URL test (type `split`) — each variation is a distinct destination URL, not a code change. Simpler: no `editorData` to inspect. |
| `vwo_web_rollout_workflow` | The same shape, for a Web Rollout (type `feature-rollout`) — mechanically identical to the A/B workflow, but with no control variation and no analytical goal. |

All three workflow prompts do real work before returning: when given a `campaignId`, each
fetches that campaign and its variations server-side — including, for the A/B and rollout
workflows, each variation's `editorData` (VWO's undocumented field for the actual DOM/JS/CSS
a variation applies) — and embeds that snapshot directly in the returned guidance, so the
model starts from real data instead of spending a turn discovering it. If the fetch fails
for any reason (bad token, wrong id, ambiguous workspace), the prompt still returns
successfully — it degrades to telling the model to fetch that information itself.

The workflow each prescribes, in short: for an existing campaign, understand what's there
in your own words before touching anything (either its code, for A/B/rollout, or which URL
each variation points to, for split); for a brand-new one, run a full requirements
checklist first (below) since **this server has no `delete_campaign` tool** — once
`vwo_new_campaign` succeeds there's no undoing it through this API. Either way: plan the
specific change and say so before calling a write tool; apply one focused change; then
verify it visually — see [Verifying a change in a browser](#verifying-a-change-in-a-browser)
below — before considering it done; iterate using user feedback, with a cap so it doesn't
loop blindly forever. Shared machinery (snapshot fetch, verify/iterate text, wrap-up) lives
in [`src/prompts/shared.ts`](src/prompts/shared.ts); read
[`src/prompts/abTestWorkflow.ts`](src/prompts/abTestWorkflow.ts) and its two siblings for
the exact text.

**New-campaign checklists.** Nothing gets inferred silently except items with a stated
default. Shared by all three: workspace, page targeting (`urls`/`excludedUrls` — explicitly
confirmed, never silently assumed to be "just this one page"); **audience defaults to All
Visitors with no segment filtering** unless stated otherwise, stated explicitly in the plan
so it's easy to override. Then per campaign type:

- **A/B test**: campaign type asked if ambiguous between `ab`/`split`/`multivariate` (real
  VWO values — see [type value corrections](#where-the-docs-and-the-live-api-disagree)
  below); at least one goal required; traffic split defaults even across variations;
  variation count and what each one does are extracted from the request if implied, or
  asked per-variation if vague.
- **Split test**: type is fixed at `split` (stated, not asked, since invoking this prompt
  already answers that); each variation needs its own explicit destination URL — never
  invented; still requires goals, same as an A/B test (a split test is still a controlled
  experiment). One genuinely open question flagged in the prompt itself: VWO's API doesn't
  document which field carries a variation's destination URL — the model is told to inspect
  what VWO actually returns rather than guess a field name, and to check VWO's support docs
  if that isn't enough.
- **Web rollout**: type is fixed at `feature-rollout`; no goal is asked for — the prompt has
  the model try `goals: []` first (VWO's schema shows no minimum length, though that's not
  a server-side guarantee) and falls back to a placeholder goal only if VWO rejects the
  empty array, explaining to the user why it exists; no control variation, just one, at a
  rollout percentage that defaults to 100% unless the user wants a staged rollout.

### Prompts: what they are and their limits

Prompts are *offered* by the server, but nothing in MCP requires a host to do anything
with them. `tools/call` is universal because it's the entire point of a tool-using agent;
`prompts/list` and `prompts/get` are separate calls a host has to choose to make. Claude
Code wires prompts up as slash commands (`/mcp__vwo__vwo_ab_test_workflow`, and likewise
for the split-test and rollout ones), so a person can invoke one directly. Whether *the
model itself* ever decides to call `prompts/get` depends entirely on your own wrapper's
logic — nothing about registering a prompt makes an agent aware it exists unless the host
lists prompts for it or a human invokes one.

That's why the server-level `instructions` field (sent once, automatically, at connect
time — see [`src/index.ts`](src/index.ts)) explicitly names all four prompts: it's the one
guaranteed way to make the model aware they exist without your wrapper doing anything
extra. If your wrapper's agent loop calls `prompts/list` itself and decides when to invoke
one based on the user's request, that's the more autonomous version of this — but it's
work your wrapper has to do; this server can't reach into your agent loop and invoke its
own prompt on the model's behalf.

### Verifying a change in a browser

`vwo_get_campaign_share_link` does **not** return a live preview. I checked VWO's actual
response schema before writing anything that depends on it: it returns a link into VWO's
own dashboard summary/report page (`https://app.wingify.com/#/campaign/{id}/summary?token=...`),
and there is no separate "preview URL" endpoint anywhere in VWO's v2 API.

What VWO's product actually provides: that summary page hosts a preview control — a field
to enter a URL and a button that opens a live rendering of the campaign for that URL in a
new tab. That's a UI feature, not an API contract, so the prompts tell the model to locate
it visually (via a screenshot) rather than assume fixed coordinates or a stable selector.
The intended flow, if a browser automation tool is present in the session — the prompts
check for *any* browser automation capability, not specifically a tool named "Chrome
DevTools MCP":

1. Open the share link.
2. Find the preview control, enter the campaign's `primaryUrl`, activate it.
3. It opens a new tab with the variation actually rendered — enumerate open tabs to find
   it, switch to it, screenshot it, and compare against the specific intended change (for
   the split-test workflow: compare against the intended *destination URL* instead — there
   is no DOM to diff, and VWO's traffic split may route a given visit to any variation, so
   one preview attempt confirms landing on one expected destination, not all of them at
   once).
4. On a further edit, reload that same tab rather than reopening the share link and
   re-clicking through the control each time.

**If no browser tool is available at all, the prompt tells the model to say so explicitly
and immediately** — not discover the gap silently after attempting a call, and not quietly
downgrade to a weaker check while implying the change was verified. It then tries, in
order: ask the user to open the share link and preview control themselves and report what
they see (their report counts as verification); failing that, fall back to re-fetching the
variation to confirm `editorData` stored the intended edit — and explicitly label that
outcome **unverified**, since confirming the data was stored is not the same as confirming
it rendered. The point is that the model should never report a content change as "done"
with more confidence than it actually earned.

## Quick start

Requires **Node.js >= 20.19** (declared in `package.json`'s `engines` field).

```bash
npm install && npm run build
```

Then set a token and confirm it works — this makes one real API call and prints a diagnostic:

```bash
VWO_API_TOKEN=your-token-here node dist/index.js --verify
```

Exit code `0` means the credentials work. Generate a token at
<https://app.vwo.com/#/developers/tokens>.

To actually register the server with Claude Code and/or Claude Desktop, see
[GETTING-STARTED.md](GETTING-STARTED.md) — `node scripts/register_mcp_server_claude.js` does
the build, the link, and the host config in one interactive pass.

---

## Configuring the API token

This is the part worth getting right, so here is how MCP servers handle it in general
before the specifics.

**The model never sees the token, because the token is never part of the MCP
conversation.** An MCP server is a separate process. The host (your agent wrapper)
launches it and passes secrets through the process environment — the same way you'd
configure any CLI tool. The agent only ever sees tool *results*. There is no code path
by which the token reaches the model's context: it is read once at startup in
[`src/config.ts`](src/config.ts), attached to outbound requests in
[`src/vwo/client.ts`](src/vwo/client.ts), and scrubbed from every log line and tool
result by [`src/redact.ts`](src/redact.ts).

That is the standard pattern — the official GitHub, Slack, and Postgres MCP servers all
work this way.

### Option A — `.mcp.json` in the consuming project, with variable expansion (recommended)

Drop [`examples/mcp.json`](examples/mcp.json) into the root of the project that uses the
server, as `.mcp.json`. Claude Code expands `${VAR}` and `${VAR:-default}` in `command`,
`args`, `env`, `url`, and `headers` — so the file references the secret without
containing it, and stays safe to commit:

```json
{
  "mcpServers": {
    "vwo": {
      "type": "stdio",
      "command": "node",
      "args": ["${VWO_MCP_HOME:-../unofficial-vwo-mcp-server}/dist/index.js"],
      "env": {
        "VWO_API_TOKEN": "${VWO_API_TOKEN}"
      }
    }
  }
}
```

`VWO_API_TOKEN` then comes from wherever you keep it — your shell profile, your OS
keychain, or `.claude/settings.local.json` (below). If it's unset, Claude Code loads the
config anyway and reports a missing-variable warning in `claude mcp list`.

Project-scoped `.mcp.json` servers need one-time approval; Claude Code prompts on first
use, or you can pre-approve with `"enabledMcpjsonServers": ["vwo"]` in
`.claude/settings.json`.

**Scopes.** `--scope project` writes `.mcp.json` (shared, committed). `--scope local` —
the default — writes `~/.claude.json` under that project's path, which is private to you
and never in version control. Local scope is the better home for a literal token:

```bash
claude mcp add vwo --scope local --env VWO_API_TOKEN=your-token -- node /abs/path/dist/index.js
```

### Option A2 — `.claude/settings.local.json` to supply the variable

`.claude/settings.json` supports an `env` block whose variables apply to the session *and
to subprocesses Claude Code spawns*, which includes MCP servers. Put the secret in
`.claude/settings.local.json` — Claude Code gitignores that file when it creates it, and
it overrides the committed `settings.json`:

```json
{
  "env": {
    "VWO_API_TOKEN": "your-token-here"
  }
}
```

Pair it with the committed `.mcp.json` from Option A: the shared file declares the
server, the personal file supplies the credential. If you create
`settings.local.json` by hand, add it to `.gitignore` yourself.

Most hosts work the same way — a `command`/`args`/`env` block — but the exact file and key
names vary. Two more, each verified against its current docs rather than assumed:

**VS Code** (native MCP support). Save [`examples/vscode-mcp.json`](examples/vscode-mcp.json)
as `.vscode/mcp.json` (workspace) or via the **MCP: Open User Configuration** command
(user profile, applies to all workspaces). The top-level key is `servers`, not
`mcpServers`. Secrets use an `inputs` block instead of shell expansion:

```json
{
  "inputs": [
    { "type": "promptString", "id": "vwo-api-token", "description": "VWO API token", "password": true }
  ],
  "servers": {
    "vwo": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unofficial-vwo-mcp-server/dist/index.js"],
      "env": { "VWO_API_TOKEN": "${input:vwo-api-token}" }
    }
  }
}
```

VS Code prompts for the token the first time the server starts and stores it securely —
it's never written into `mcp.json`.

**Codex CLI.** Append to [`examples/codex-config.toml`](examples/codex-config.toml) at
`~/.codex/config.toml` (all projects) or `./.codex/config.toml` (this project). Codex's
config is TOML, not JSON, and has no `${VAR}` expansion — instead, `env_vars` forwards
specific variables that are already set in your shell into the server's process:

```toml
[mcp_servers.vwo]
command = "node"
args = ["/absolute/path/to/unofficial-vwo-mcp-server/dist/index.js"]
env_vars = ["VWO_API_TOKEN"]
```

Any other host follows the same shape — declare the server, supply `VWO_API_TOKEN`
however that host keeps secrets out of its config file:

```jsonc
{
  "mcpServers": {
    "vwo": {
      "command": "node",
      "args": ["/absolute/path/to/unofficial-vwo-mcp-server/dist/index.js"],
      "env": { "VWO_API_TOKEN": "your-token-here" }
    }
  }
}
```

If a token ends up literally in a config file, protect it like any credential file
(`chmod 600`, never committed).

### Option B — a token file (better isolation)

A process's environment is readable by other processes on some systems (`ps -e`,
`/proc/<pid>/environ`). To avoid that, point the server at a file whose entire contents
are the token:

```jsonc
"env": { "VWO_API_TOKEN_FILE": "/run/secrets/vwo_api_token" }
```

`VWO_API_TOKEN_FILE` takes precedence over `VWO_API_TOKEN`. This composes directly with
Docker/Kubernetes secret mounts and with `pass`/`age`-style secret files.

### Option C — reading from an OS keychain at spawn time

Best of both for a desktop wrapper: keep the secret in the OS keychain and resolve it
only when launching the child process, so it is never written to disk in plaintext.

```ts
// In your agent wrapper, when spawning the MCP server:
const token = await keytar.getPassword('vwo-mcp', 'api-token'); // or `security find-generic-password` / DPAPI
const child = spawn('node', ['dist/index.js'], {
    env: { ...process.env, VWO_API_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe']
});
```

Your wrapper owns the "ask the user for their key once, store it securely" UX; the MCP
server stays a dumb consumer of an env var. That separation is deliberate — it keeps the
server usable from any host.

### Option D — `.env` for local development only

Copy [`.env.example`](.env.example) to `.env`. `.env` is gitignored. Note the server does
**not** load `.env` itself; use your shell or a runner:

```bash
node --env-file=.env dist/index.js --verify
```

### Why the token is not a tool parameter

A tempting alternative is an `authenticate(apiKey)` tool. Don't — it is the one design
that actively breaks the security property:

- The model would have to *know* the key to pass it, so it lands in the context window.
- It would be written into conversation transcripts and any logging around them.
- It would be replayed on every tool call, multiplying exposure.
- Anything that can read the transcript — including a prompt injection that gets the
  agent to repeat it — can exfiltrate it.

Secrets belong in the process boundary, not the conversation. There is intentionally no
tool in this server that accepts, sets, or returns a token.

### If you later expose this over HTTP instead of stdio

For a multi-tenant or remote deployment, per-user tokens in the server environment stop
making sense. MCP's answer is OAuth 2.1: the server acts as an OAuth Resource Server and
each request carries the caller's bearer token. The SDK ships the pieces
(`verifyBearerToken`, `OAuthTokenVerifier`, protected-resource metadata helpers). That is
a different architecture from this one — out of scope here, but the client and tool layers
would carry over unchanged since auth is isolated to `config.ts` + `client.ts`.

### All configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VWO_API_TOKEN` | yes* | — | API token. |
| `VWO_API_TOKEN_FILE` | yes* | — | Path to a file containing the token. Wins over `VWO_API_TOKEN`. |
| `VWO_ACCOUNT_ID` | no | — | Default account: a numeric id, or `current`. Unset means tools require an explicit `accountId`. |
| `VWO_ALLOWED_ACCOUNT_IDS` | no | unrestricted | Comma-separated allow-list of account ids this server may touch. |
| `VWO_API_BASE_URL` | no | `https://app.wingify.com/api/v2` | Set to `https://app.vwo.com/api/v2` for the older host. Must be https and end in `/v2`. |
| `VWO_AUTH_HEADER` | no | `token` | Header carrying the token, per VWO's docs. |
| `VWO_MIN_REQUEST_INTERVAL_MS` | no | `1000` | Request spacing. VWO allows 1 req/sec per token. |
| `VWO_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout. |
| `VWO_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. Goes to stderr. |

\* One of the two is required. Startup fails with exit code `78` (`EX_CONFIG`) and an
actionable message if neither is set.

---

## Which tools auto-run and which need approval

This is a **host** concern, not something `.mcp.json` controls. In Claude Code it lives in
`.claude/settings.json` under `permissions` — see
[`examples/claude-settings.json`](examples/claude-settings.json):

```json
{
  "enabledMcpjsonServers": ["vwo"],
  "permissions": {
    "allow": ["mcp__vwo__vwo_verify_connection", "mcp__vwo__vwo_list_*", "mcp__vwo__vwo_get_*"],
    "ask":   ["mcp__vwo__vwo_new_*", "mcp__vwo__vwo_create_*", "mcp__vwo__vwo_add_*", "mcp__vwo__vwo_update_*"],
    "deny":  ["mcp__vwo__vwo_delete_*"]
  }
}
```

The tool names are deliberately prefix-consistent so this stays a four-line policy:
`vwo_list_*` and `vwo_get_*` are exactly the read tools, and every mutating tool starts
with `vwo_new_`, `vwo_create_`, `vwo_add_`, `vwo_update_`, or `vwo_delete_`. Move
`vwo_delete_*` from `deny` to `ask` when you want deletions available.

The `mcp__vwo__` and `vwo_` prefixes look redundant here on purpose: `mcp__vwo__` is
Claude Code's server namespace and disappears in hosts that don't add one, while `vwo_`
is this server's own prefix and is what the model actually reads in tool descriptions and
error messages (`"call vwo_list_workspaces first"`) regardless of host. If you expect to
run this server alongside others that also prefix their own tools, the double prefix is
the price of names that stay meaningful outside Claude Code too — see [multiple MCP
servers](#running-alongside-other-mcp-servers).

Matcher syntax:

| Pattern | Matches |
| --- | --- |
| `mcp__vwo` | every tool from the `vwo` server |
| `mcp__vwo__*` | same, wildcard form |
| `mcp__vwo__vwo_list_campaigns` | that one tool |
| `mcp__vwo__vwo_get_*` | its `vwo_get_` tools |

The server name is whatever key you used in `.mcp.json`. Allow-rule globs are only
permitted *after* a literal `mcp__<server>__` prefix — a bare `"*"` or `"mcp__*"` in
`allow` is ignored with a warning. `deny` and `ask` accept broader globs, so
`"deny": ["mcp__*"]` blocks all MCP tools.

Put the rules in committed `.claude/settings.json` to share them, or
`.claude/settings.local.json` to keep them personal (local wins).

### Running alongside other MCP servers

If your wrapper also loads, say, Chrome DevTools MCP, every tool name arrives in the
model's context at once. Two reasons `vwo_` earns its keep in that situation specifically:

- Not every host namespaces by server the way Claude Code does. A wrapper that flattens
  tool names, or a host with no namespacing convention at all, would otherwise expose a
  bare `list_campaigns` sitting next to some other server's `list_pages` with nothing
  marking either as belonging to a particular integration.
- Namespacing only covers the tool *list*. Tool descriptions and this server's own error
  messages reference other tools by name in prose (`"call vwo_list_workspaces first"`),
  and that text is host-agnostic — it reads correctly whether or not the host prefixes
  anything.

The trade-off is that in a host which *does* namespace, permission rules end up with the
double prefix seen above (`mcp__vwo__vwo_list_campaigns`). That's cosmetic; the glob
policy is unaffected either way.

**Two server-side backstops**, so a permissive host config can't cause damage on its own:

- Read-only tools declare `annotations.readOnlyHint`, letting hosts treat them as safe.
- Destructive tools should spread `REQUIRES_HUMAN_APPROVAL` from
  [`tools/shared.ts`](src/tools/shared.ts) into their config. Claude Code then prompts on
  every call **even in `bypassPermissions` mode and even if an `allow` rule matches**. Use
  it for anything that mutates a live experiment.

---

## Choosing which VWO account a tool acts on

Your token manages multiple accounts (VWO's UI calls them workspaces), so this is the part
most likely to go wrong quietly. The resolution order for every account-scoped tool:

1. **Explicit `accountId`** argument.
2. **`workspaceName`** argument, resolved via `GET /accounts`.
3. **`VWO_ACCOUNT_ID`** default, if configured.
4. Otherwise: **a deliberate error** telling the agent to call `vwo_list_workspaces` and ask
   the user.

Step 4 is the important one. The obvious alternative — falling back to VWO's
`accounts/current` — is the dangerous option: a multi-account token would happily run the
call against whichever account VWO considers current, which is rarely the one the user
meant. Failing with instructions costs one extra round trip and can't touch the wrong
client's data.

### So does the LLM ask, or look it up?

**It looks it up, then asks only if ambiguous.** Concretely, when the user says
*"pause the homepage test in Acme Corp"*:

1. The agent calls `vwo_list_workspaces` → `[{id: 12345, name: "Acme Corp"}, ...]`.
2. It calls `vwo_list_campaigns` with `accountId: 12345`.

You can skip step 1 by passing `workspaceName: "Acme Corp"` directly; the server resolves it.
Name resolution is deliberately strict — an unknown or ambiguous name returns an error
**listing the candidates** rather than picking one, which turns a potential wrong-account
write into a clarifying question. The tool descriptions tell the model, in as many words,
never to guess an id.

The account list is cached for 60 seconds, since VWO allows only 1 request/second per
token and name resolution would otherwise spend that budget on every call.

### Pick the setup that matches your usage

| Situation | Configuration |
| --- | --- |
| Always one account | `VWO_ACCOUNT_ID=12345` — the model never thinks about accounts. |
| Many accounts, agent chooses | Leave `VWO_ACCOUNT_ID` unset. Tools require an explicit account. |
| Many accounts, but only some in scope | `VWO_ALLOWED_ACCOUNT_IDS=12345,67890`. Anything else is refused and hidden from `vwo_list_workspaces`. |
| One agent per client | Run one server instance per account, each with its own `VWO_ACCOUNT_ID`, registered under distinct names (`vwo-acme`, `vwo-globex`). Permission rules can then differ per client. |

`VWO_ALLOWED_ACCOUNT_IDS` is enforced in two places: the account list is filtered, and any
explicit `accountId` outside the list is refused. It's the guardrail worth setting if the
token can reach clients this agent has no business touching.

---

## API version safety

The server uses **v2 only**. Worth knowing why that's enforced rather than assumed:
`https://app.wingify.com/api/v1/...` returns **HTTP 200** with a body of
`{"API_ERROR":"INCORRECT_API_VERSION"}`. A client that trusts the status code would read
that as success and hand the agent an empty result.

Two guards:

- `VWO_API_BASE_URL` must end in `/v2`, checked at startup.
- The client inspects every 2xx body for VWO's error envelopes (`_errors`, `API_ERROR`) and
  raises a `VwoApiError` if present. VWO returns errors in-band, so status codes alone are
  not trustworthy.

---

## Project layout

```
src/
  index.ts          entry: loads config, serves stdio, handles --verify
  config.ts         env + token-file loading, validation, defaults
  logger.ts         stderr-only logging (stdout is the JSON-RPC channel)
  redact.ts         secret-scrubbing registry
  vwo/
    client.ts       HTTP client: auth header, rate-limit gate, retries, error envelopes
    errors.ts       VwoApiError + agent-facing messages
    accounts.ts     account/workspace directory, name resolution, caching
    verify.ts       shared credential check
  tools/
    index.ts            single registration point for all tools
    shared.ts           ToolContext, accountArgs, resolveAccount, bodyArg, error wrapper
    campaignResource.ts factory for goals/variations/sections (identical CRUD shape)
    diagnostics.ts      vwo_verify_connection
    workspaces.ts       campaigns.ts       drafts.ts
    goals.ts            variations.ts      sections.ts
    labels.ts           metric_reports.ts  tracking_code.ts
    custom_widgets.ts   websites.ts (empty — no website tools requested yet)
  prompts/
    index.ts              single registration point for all prompts
    shared.ts             snapshot fetch, verify/wrap-up sections shared by the 3 workflows
    general.ts            vwo_general_guidance
    abTestWorkflow.ts     vwo_ab_test_workflow — same-page content changes
    splitTestWorkflow.ts  vwo_split_test_workflow — per-variation destination URLs
    webRolloutWorkflow.ts vwo_web_rollout_workflow — no control, no goal
examples/
  mcp.json             Claude Code: drop into a consuming project as .mcp.json
  claude-settings.json Claude Code: permission rules for .claude/settings.json
  vscode-mcp.json       VS Code: save as .vscode/mcp.json
  codex-config.toml     Codex CLI: append to ~/.codex/config.toml
scripts/
  register_mcp_server_claude.js  interactive: build + link + register with
                                  Claude Code and/or Claude Desktop (see GETTING-STARTED.md)
  install_package_locally.sh/.bat  build + `npm link` only, for wiring into
                                     a host's config by hand
```

## Adding a tool

1. Create `src/tools/<area>.ts` following [`campaigns.ts`](src/tools/campaigns.ts).
2. Spread `accountArgs` into the input schema and call `await resolveAccount(ctx, args)` so
   every tool targets an account identically and inherits the allow-list check.
3. Wrap the implementation in `toolHandler(name, fn)` so VWO errors become readable
   `isError` results instead of exceptions.
4. Call VWO through `ctx.client` — never construct headers or read the token in tool code.
5. For anything that mutates state, set `annotations.destructiveHint` and spread
   `REQUIRES_HUMAN_APPROVAL`.
6. Register it in [`src/tools/index.ts`](src/tools/index.ts).

Write descriptions for the agent, not for a human reading API docs: say when to reach for
the tool and what it returns, and use `annotations.readOnlyHint` / `destructiveHint`
honestly so hosts can gate write operations.

## Design notes

- **stdout is sacred.** On stdio transport, stdout carries JSON-RPC framing. All logging
  goes to stderr; `console.log` must never be used in this project.
- **Rate limiting is process-wide.** VWO allows 1 request/second per token, so one shared
  gate in `VwoClient` paces all calls regardless of how many tools fire concurrently.
- **Retries distinguish "rejected" from "possibly applied."** GETs retry on 429, 5xx, and
  network failures. Writes (POST/PATCH/DELETE) retry on **429 only** — a rate limit is refused
  at the limiter so nothing was applied, making a replay safe even for a non-idempotent write,
  whereas a 5xx or a dropped connection may mean VWO already made the change and only the
  response was lost. That distinction is `rejectedWithoutSideEffect` vs `retryable` in
  [`errors.ts`](src/vwo/errors.ts), selected per request by `RetryPolicy` in
  [`client.ts`](src/vwo/client.ts). Backoff honours `Retry-After`. Verified against a local fake
  server across all six method/failure combinations.
- **The rate-limit gate is per-process, so 429s are still reachable.** One shared gate paces this
  process at VWO's 1 req/sec, but another process using the same token spends the same budget —
  which is exactly how a 429 surfaced during testing. This is why writes retry on 429 rather than
  assuming the gate makes it impossible.
- **Errors are written for an agent.** `VwoApiError.agentMessage` tells the model whether
  a failure is worth retrying — a 401 explicitly says "configuration problem, do not retry".

## SDK version pinning

`@modelcontextprotocol/server` is pinned to an exact beta (`2.0.0-beta.3`) because v2 is
pre-stable and its API is still moving. This project's npm is configured with
`min-release-age=14`, so the newest installable beta lags the newest published one. Bump
deliberately:

```bash
npm view @modelcontextprotocol/server versions --json
npm install @modelcontextprotocol/server@<next-beta> && npm run build
```

The surfaces used are `McpServer`, `registerTool`, and `serveStdio` — the most likely
breaking changes are in tool-registration and result shapes, both confined to `src/tools/`.
