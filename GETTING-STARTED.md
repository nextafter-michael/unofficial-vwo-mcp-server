# Getting Started

A practical walkthrough: clone, build, get a token, and register the server with an MCP
host. For *why* things work the way they do — account resolution, permission gating,
prompts, the API quirks this server works around — see [README.md](README.md); this file
just gets you running.

## Prerequisites

- **Node.js >= 20.19** (declared in `package.json`'s `engines` field).
- **npm** (ships with Node).
- **A VWO API token** — generate one at <https://app.vwo.com/#/developers/tokens>. The
  token is all this server needs; it never touches your VWO password.
- To register with **Claude Code**, its CLI (`claude`) must already be installed and on
  PATH: <https://claude.com/download>.

## 1. Clone

```bash
git clone https://github.com/nextafter-michael/unofficial-vwo-mcp-server.git
cd unofficial-vwo-mcp-server
```

## 2. Install and build

```bash
npm install
npm run build
```

This compiles `src/` to `dist/`, which is what actually runs (`dist/index.js`).

## 3. Confirm your token works

This makes one real, lightweight API call and prints a diagnostic — no server needs to be
registered anywhere yet:

```bash
VWO_API_TOKEN=your-token-here node dist/index.js --verify
```

Exit code `0` means the token is valid and VWO is reachable. If it fails, the printed
message says why (bad token, wrong base URL, etc.) — see README.md's
[API version safety](README.md#api-version-safety) section if it mentions API versioning.

## 4. Register it with a host

This package is `"private": true` and has never been published to npm, so most hosts can't
just `npx unofficial-vwo-mcp-server` out of the box — that 404s from the registry unless the
package is already resolvable locally. The scripts below handle that for you.

### Recommended: the interactive registration script (Claude Code and/or Claude Desktop)

```bash
node scripts/register_mcp_server_claude.js
```

(equivalently `npm run register:claude`). This one script:

- Builds the project and runs `npm link` for you — no need to have done steps 2–3 by hand
  first, though it's harmless if you already did.
- Asks which Claude app(s) to register with: the Code CLI, the Desktop app, or both
  (default).
- Prompts for your VWO API token with **input hidden** (not echoed to the terminal).
- For Claude Code, asks which scope: `local` (this project only), `user` (every project on
  this machine), or `project` (shared via `.mcp.json`, needs teammates' approval too).
- For Claude Desktop, edits `claude_desktop_config.json` directly — backing up the existing
  file first and touching only its own entry, never anything else already in that file —
  then asks whether to restart Claude Desktop now to pick up the change, or you'll do it
  yourself later.
- If a registration with the same name already exists, asks before replacing it.

Non-interactive flags exist for scripting (`--target=`, `--scope=`, `--token=`, `--yes`,
`--restart`/`--no-restart`) — run with `--help`-equivalent by reading the flags documented
in the file's own header comment.

### Alternative: just link the package, wire up the host config yourself

If you'd rather configure your host's MCP config by hand — see README.md's
[Configuring the API token](README.md#configuring-the-api-token) section for Claude Code,
VS Code, and Codex CLI examples — you only need the package resolvable on PATH:

```bash
./scripts/install_package_locally.sh    # macOS/Linux
scripts\install_package_locally.bat     # Windows
```

This builds the project and runs `npm link`, so `"command": "unofficial-vwo-mcp-server"`
works in any host config in place of `"command": "node", "args": ["/absolute/path/dist/index.js"]`.
Undo with `npm unlink -g unofficial-vwo-mcp-server`.

## 5. Confirm it's actually connected

Once registered, ask your agent to call the `vwo_verify_connection` tool (or, in Claude
Code, run `claude mcp get unofficial-vwo-mcp-server` from a terminal). A successful result
includes a token fingerprint (never the token itself) and the list of VWO workspaces your
token can see.

## What's next

- [README.md § Choosing which VWO account a tool acts on](README.md#choosing-which-vwo-account-a-tool-acts-on) —
  read this before your first real tool call if the token manages more than one VWO
  workspace.
- [README.md § Which tools auto-run and which need approval](README.md#which-tools-auto-run-and-which-need-approval) —
  set up permission rules before letting an agent make changes unattended.
- [README.md § Prompts](README.md#prompts) — `vwo_general_guidance` and the three
  campaign-editing workflow prompts (A/B test, split test, web rollout) are worth knowing
  about before asking an agent to create or edit a live campaign.
