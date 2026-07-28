#!/usr/bin/env node
/**
 * Registers this MCP server with Claude Code (via `claude mcp add`) and/or
 * Claude Desktop (by editing claude_desktop_config.json directly — Desktop
 * has no CLI of its own), prompting interactively for target, token, and
 * (for Claude Code) registration scope.
 *
 * Why Claude Code needs more than the one-liner it's built on
 * (`claude mcp add unofficial-vwo-mcp-server -e VWO_API_TOKEN=... -- npx -y
 * unofficial-vwo-mcp-server`): this package is `"private": true` and has
 * never been published to npm, so a bare `npx -y unofficial-vwo-mcp-server`
 * 404s from the registry unless the package is already resolvable on PATH.
 * `npm link` (verified against a real npx invocation from an unrelated
 * directory while writing this script) makes npx resolve it locally without
 * touching the registry — so this script builds and links the package
 * first, THEN registers the npx-based command, which is what makes that
 * command actually work once Claude Code spawns it later from some other
 * project's working directory. That also means the Claude Code registration
 * has a real dependency: if the global link is ever removed (`npm unlink -g
 * unofficial-vwo-mcp-server`), it will start failing to connect.
 *
 * Claude Desktop's registration deliberately does NOT use npx+link: Desktop
 * has no equivalent of `claude mcp get` to notice and explain a connection
 * failure, so its entry points `node` directly at this package's built
 * `dist/index.js` by absolute path instead — one less thing that can quietly
 * stop working later.
 *
 * No new dependencies: only Node builtins (fs, child_process, os, path,
 * url), consistent with the rest of this package. Prompting is hand-rolled
 * directly over raw stdin rather than via `readline` — see the comment on
 * `readLine` below for why mixing the two is unsound.
 *
 * Non-interactive overrides (mainly for scripting/testing — prompts are
 * still the primary interface, per the original ask):
 *   --target=code|desktop|both skip the target prompt
 *   --token=<value>            skip the token prompt
 *   --scope=local|user|project skip the scope prompt (Claude Code only)
 *   --yes                      auto-confirm overwriting an existing registration
 *   --restart / --no-restart   skip the "restart Claude Desktop now?" prompt
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = new URL('..', import.meta.url);
const DIST_INDEX_PATH = fileURLToPath(new URL('dist/index.js', PROJECT_DIR));

const pkg = JSON.parse(readFileSync(new URL('package.json', PROJECT_DIR), 'utf8'));
const SERVER_NAME = pkg.name;
const BIN_NAME = Object.keys(pkg.bin)[0];

const SCOPES = {
    local: 'private to you, only in this project (default)',
    user: 'available to you across every project on this machine',
    project: 'shared with your team via .mcp.json (needs their approval too)'
};

const TARGETS = {
    both: 'Claude Code CLI and Claude Desktop (default)',
    code: 'Claude Code CLI only',
    desktop: 'Claude Desktop only'
};

/**
 * Characters already received but not yet consumed by any `readLine()` call
 * (defined further below) — carried over between calls. Needs to be
 * initialized here, ahead of `main().catch(...)`, not just textually above
 * `readLine` itself: `main()` reaches `readLine`'s first reference to this
 * synchronously — `buildAndLink()` blocks on `execSync` without ever
 * yielding — so if this declaration were any later in the module, that
 * reference would fire before the module's own top-level evaluation ever
 * reached it, which is exactly the `let`/TDZ crash this ordering avoids.
 */
let pendingInput = '';

const args = parseArgs(process.argv.slice(2));

main().catch(error => {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
});

async function main() {
    const target = args.target ?? (await promptTarget());
    const wantsCode = target !== 'desktop';
    const wantsDesktop = target !== 'code';

    if (wantsCode) assertClaudeCliAvailable();
    buildAndLink(); // both targets need dist/index.js to exist; Code additionally needs the link

    const scope = wantsCode ? args.scope ?? (await promptScope()) : undefined;
    const token = args.token ?? (await promptToken());

    if (wantsCode) {
        await registerCode(scope, token);
    }

    const desktopRegistered = wantsDesktop && (await registerDesktop(token));
    if (desktopRegistered) {
        const restartNow = args.restart ?? (await promptYesNo('\nRestart Claude Desktop now to apply the change?'));
        if (restartNow) {
            restartClaudeDesktop();
        } else {
            console.log("OK — restart Claude Desktop yourself whenever you're ready for the change to take effect.");
        }
    }
}

async function registerCode(scope, token) {
    const addArgs = ['mcp', 'add', '-e', `VWO_API_TOKEN=${token}`, '-s', scope, SERVER_NAME, '--', 'npx', '-y', BIN_NAME];

    let result = spawnSync('claude', addArgs, { encoding: 'utf8' });
    if (result.status !== 0) {
        // `claude mcp get`/`list` can't be queried per-scope, so a name that
        // exists at more than one scope can't be checked for reliably in
        // advance — confirmed while writing this script: with both a local
        // and a user registration present, a bare `get` silently reports only
        // one of them. `add` and `remove` DO respect scope correctly, though,
        // so the reliable way to detect a conflict is to attempt the add and
        // read the specific error it gives back.
        const detail = (result.stderr || result.stdout || '').trim();
        if (!/already exists/i.test(detail)) {
            throw new Error(`'claude ${addArgs.join(' ')}' failed: ${detail}`);
        }
        const overwrite =
            args.yes ?? (await promptYesNo(`'${SERVER_NAME}' is already registered at scope '${scope}'. Replace it?`));
        if (!overwrite) {
            console.log('Left the existing Claude Code registration untouched.');
            return;
        }
        runClaude(['mcp', 'remove', SERVER_NAME, '-s', scope]);
        result = spawnSync('claude', addArgs, { encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error(`'claude ${addArgs.join(' ')}' failed: ${(result.stderr || result.stdout || '').trim()}`);
        }
    }

    console.log(`\nRegistered '${SERVER_NAME}' with Claude Code at scope '${scope}'. Checking it connects...`);
    const check = runClaude(['mcp', 'get', SERVER_NAME], { allowFailure: true });
    if (!check.stdout.includes(`Scope: ${scopeLabel(scope)}`)) {
        // Same ambiguity as above, in the other direction: if another scope's
        // entry for this name shadows the one just registered, say so rather
        // than reporting that other entry's (possibly stale) status as if it
        // were confirmation of this one.
        console.log(
            `A '${SERVER_NAME}' registration exists at another scope too, so 'claude mcp get' can't ` +
                `confirm this specific one from here. Run 'claude mcp remove ${SERVER_NAME} -s <other scope>' ` +
                'first if you want an unambiguous check, or just try the tool from Claude Code directly.'
        );
    } else {
        console.log(check.stdout.trim());
        if (!check.stdout.includes('Connected')) {
            console.log(
                "\nThat didn't report as connected — this can be the first-run npx cache warming up. " +
                    `Run 'claude mcp get ${SERVER_NAME}' again in a moment, or 'claude mcp remove ${SERVER_NAME} -s ${scope}' to undo.`
            );
        }
    }

    console.log(
        `\nNote: this Claude Code registration runs the server via 'npx ${BIN_NAME}', which resolves ` +
            "because the package is npm-linked globally (done above). If you ever run " +
            `'npm unlink -g ${SERVER_NAME}', this registration will stop connecting until you re-link ` +
            '(scripts/install_package_locally) or re-run this script.'
    );
}

/**
 * Registers (or updates) this server in claude_desktop_config.json.
 * Returns true if it actually wrote the file (false if declined or already
 * present — the caller uses this to decide whether a restart is relevant).
 *
 * Deliberately does NOT touch anything in the config besides
 * `mcpServers[SERVER_NAME]` — confirmed on a real installation while writing
 * this that the file commonly holds unrelated top-level settings
 * (`preferences`, etc.), which a naive "read, modify, write the whole
 * object back" is safe for ONLY if nothing else is ever reassigned wholesale.
 */
async function registerDesktop(token) {
    const configPath = getDesktopConfigPath();
    const config = readDesktopConfig(configPath);

    if (config.mcpServers?.[SERVER_NAME]) {
        const overwrite =
            args.yes ??
            (await promptYesNo(`'${SERVER_NAME}' is already registered in Claude Desktop's config. Replace it?`));
        if (!overwrite) {
            console.log('Left the existing Claude Desktop registration untouched.');
            return false;
        }
    }

    if (existsSync(configPath)) {
        const backupPath = `${configPath}.bak-${Date.now()}`;
        copyFileSync(configPath, backupPath);
        console.log(`Backed up the existing Claude Desktop config to ${backupPath}`);
    }

    config.mcpServers = {
        ...config.mcpServers,
        [SERVER_NAME]: {
            command: 'node',
            args: [DIST_INDEX_PATH],
            env: { VWO_API_TOKEN: token }
        }
    };

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\nRegistered '${SERVER_NAME}' with Claude Desktop: ${configPath}`);
    return true;
}

function getDesktopConfigPath() {
    switch (process.platform) {
        case 'darwin':
            return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        case 'win32': {
            const appData = process.env.APPDATA;
            if (!appData) {
                throw new Error('%APPDATA% is not set — cannot locate the Claude Desktop config directory.');
            }
            return join(appData, 'Claude', 'claude_desktop_config.json');
        }
        case 'linux':
            return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
        default:
            throw new Error(`Don't know where Claude Desktop's config lives on platform '${process.platform}'.`);
    }
}

/** Never silently discards an existing file it can't parse — that file may hold real settings worth keeping. */
function readDesktopConfig(configPath) {
    if (!existsSync(configPath)) {
        return {};
    }
    const raw = readFileSync(configPath, 'utf8').trim();
    if (raw === '') {
        return {};
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `${configPath} exists but isn't valid JSON (${error.message}). Not touching it automatically — ` +
                'it may hold other real settings worth keeping. Fix or back it up by hand, then run this again.'
        );
    }
}

function restartClaudeDesktop() {
    switch (process.platform) {
        case 'win32':
            restartClaudeDesktopWindows();
            break;
        case 'darwin':
            restartClaudeDesktopMac();
            break;
        case 'linux':
            restartClaudeDesktopLinux();
            break;
        default:
            console.log(`Don't know how to restart Claude Desktop on '${process.platform}' — restart it yourself.`);
    }
}

/**
 * Verified on a real machine while writing this script — both the install
 * path and, importantly, that "claude.exe" also names OTHER, unrelated
 * processes there (a separate Claude Code CLI copy, a VS Code extension's
 * bundled CLI binary). Matching by process name alone would risk killing
 * those instead of just Claude Desktop, so this matches by executable path
 * under the real AnthropicClaude install directory instead, never by name.
 */
function restartClaudeDesktopWindows() {
    const installDir = join(process.env.LOCALAPPDATA ?? '', 'AnthropicClaude');
    const launcherPath = join(installDir, 'claude.exe');

    // spawnSync with an argv array, no shell — verified directly against this
    // exact command while writing this script. Routing the same PowerShell
    // command through execSync's shell layer instead would mean the nested
    // double quotes in the -Filter argument need re-escaping for cmd.exe on
    // top of PowerShell's own quoting, which is exactly the kind of thing
    // that broke elsewhere in this project; passing it as one argv element
    // sidesteps that entirely.
    const psResult = spawnSync(
        'powershell',
        [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json"
        ],
        { encoding: 'utf8' }
    );

    let processes;
    try {
        if (psResult.error || psResult.status !== 0) {
            throw new Error(psResult.error?.message ?? psResult.stderr.trim());
        }
        const raw = psResult.stdout.trim();
        const parsed = raw === '' ? [] : JSON.parse(raw);
        processes = Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
        console.log(`Could not list Claude Desktop processes (${error.message}). Restart it yourself.`);
        return;
    }

    const installDirLower = installDir.toLowerCase();
    const ownProcesses = processes.filter(p => p.ExecutablePath?.toLowerCase().startsWith(installDirLower));

    if (ownProcesses.length === 0) {
        console.log('Claude Desktop does not appear to be running.');
    } else {
        for (const p of ownProcesses) {
            spawnSync('taskkill', ['/PID', String(p.ProcessId), '/F'], { stdio: 'ignore' });
        }
        console.log(`Stopped ${ownProcesses.length} Claude Desktop process(es).`);
    }

    if (!existsSync(launcherPath)) {
        console.log(`Could not find ${launcherPath} to relaunch it — open Claude Desktop yourself.`);
        return;
    }
    spawn(launcherPath, [], { detached: true, stdio: 'ignore' }).unref();
    console.log('Relaunched Claude Desktop.');
}

/**
 * NOT verified against a real installation — written from Claude Desktop's
 * documented macOS behavior only (unlike the Windows path above). If this
 * doesn't work, just quit and reopen Claude Desktop yourself.
 */
function restartClaudeDesktopMac() {
    spawnSync('killall', ['Claude'], { stdio: 'ignore' });
    const result = spawnSync('open', ['-a', 'Claude'], { encoding: 'utf8' });
    if (result.status === 0) {
        console.log('Restarted Claude Desktop.');
    } else {
        console.log("Couldn't confirm Claude Desktop restarted — open it yourself if it's not running.");
    }
}

/**
 * NOT verified against a real installation — Claude Desktop's Linux support
 * is community-packaged, not officially distributed, so there's no single
 * expected binary name. Best effort only; if this doesn't work, restart it
 * yourself however you normally launch it.
 */
function restartClaudeDesktopLinux() {
    spawnSync('pkill', ['-f', 'claude-desktop'], { stdio: 'ignore' });
    const result = spawnSync('claude-desktop', [], { detached: true, stdio: 'ignore' });
    if (result.error) {
        console.log("Couldn't relaunch Claude Desktop automatically on Linux — start it yourself.");
    } else {
        console.log('Attempted to restart Claude Desktop.');
    }
}

function parseArgs(argv) {
    const parsed = {};
    for (const arg of argv) {
        if (arg === '--yes') {
            parsed.yes = true;
        } else if (arg === '--restart') {
            parsed.restart = true;
        } else if (arg === '--no-restart') {
            parsed.restart = false;
        } else if (arg.startsWith('--token=')) {
            parsed.token = arg.slice('--token='.length);
        } else if (arg.startsWith('--scope=')) {
            const scope = arg.slice('--scope='.length);
            if (!Object.hasOwn(SCOPES, scope)) {
                throw new Error(`--scope must be one of: ${Object.keys(SCOPES).join(', ')}`);
            }
            parsed.scope = scope;
        } else if (arg.startsWith('--target=')) {
            const target = arg.slice('--target='.length);
            if (!Object.hasOwn(TARGETS, target)) {
                throw new Error(`--target must be one of: ${Object.keys(TARGETS).join(', ')}`);
            }
            parsed.target = target;
        }
    }
    return parsed;
}

function assertClaudeCliAvailable() {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        throw new Error("Claude Code CLI ('claude') was not found on PATH. Install it first: https://claude.com/download");
    }
}

/**
 * Idempotent: same steps as scripts/install_package_locally.*, run directly
 * so this script has no cross-script dependency.
 *
 * `execSync` (a shell command string) is used here — and ONLY here — because
 * on Windows `npm` is a `.cmd` shim that Node's child_process won't resolve
 * without going through a shell. It's safe for these three calls
 * specifically because every argument is a fixed literal, never user input
 * or a secret; `runClaude` below carries the token and deliberately uses
 * `spawnSync` with an argv array and no shell, for the opposite reason.
 */
function buildAndLink() {
    console.log('==> Installing dependencies');
    execSync('npm install', { cwd: PROJECT_DIR, stdio: 'inherit' });

    console.log('==> Building');
    execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });

    console.log(`==> Linking ${SERVER_NAME} globally`);
    execSync('npm link', { cwd: PROJECT_DIR, stdio: 'inherit' });
}

/** Runs `claude` with argv passed directly (no shell) so a token can never be misparsed or injected. */
function runClaude(claudeArgs, { allowFailure = false } = {}) {
    const result = spawnSync('claude', claudeArgs, { encoding: 'utf8' });
    if (result.status !== 0 && !allowFailure) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`'claude ${claudeArgs.join(' ')}' failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
}

function scopeLabel(scope) {
    switch (scope) {
        case 'local':
            return 'Local config';
        case 'user':
            return 'User config';
        case 'project':
            return 'Project config';
        default:
            return scope;
    }
}

async function promptTarget() {
    console.log('Which Claude app(s) should this server be registered with?');
    const entries = Object.entries(TARGETS);
    entries.forEach(([name, description], i) => console.log(`  ${i + 1}) ${description}`));
    for (;;) {
        const answer = (await readLine(`Choice [1-${entries.length}, default 1]: `)).trim();
        if (answer === '') return entries[0][0];
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && entries[index]) return entries[index][0];
        console.log('Please enter a number from the list.');
    }
}

async function promptScope() {
    console.log('\nWhere should this server be registered with Claude Code?');
    const entries = Object.entries(SCOPES);
    entries.forEach(([name, description], i) => console.log(`  ${i + 1}) ${name} — ${description}`));
    for (;;) {
        const answer = (await readLine(`Choice [1-${entries.length}, default 1]: `)).trim();
        if (answer === '') return entries[0][0];
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && entries[index]) return entries[index][0];
        console.log('Please enter a number from the list.');
    }
}

async function promptToken() {
    for (;;) {
        const value = (await readLine('VWO API token (input hidden): ', { mask: true })).trim();
        if (value !== '') return value;
        console.log('A token is required — generate one at https://app.vwo.com/#/developers/tokens');
    }
}

async function promptYesNo(question) {
    const answer = (await readLine(`${question} [y/N]: `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
}

const KEY_ENTER = new Set(['\n', '\r', '']); //  = Ctrl-D
const KEY_INTERRUPT = ''; // Ctrl-C
const KEY_BACKSPACE = new Set(['', '\b']); // DEL and BS, depending on terminal

/**
 * The one input primitive every prompt in this script uses — deliberately
 * not `readline`. Mixing a `readline.Interface` for some prompts with a raw
 * stdin reader for a masked one (an earlier version of this script did
 * exactly that) is unsound: readline can buffer more from the stream than it
 * strictly needs for one question, and whatever it over-reads is gone once
 * it closes, so the next prompt's raw reader never sees it and hangs
 * forever. Using this same mechanism for every prompt avoids that class of
 * bug entirely, at the cost of not getting terminal line-editing (arrow
 * keys, etc.) for free — acceptable for a handful of short setup prompts.
 */
function readLine(prompt, { mask = false } = {}) {
    return new Promise(resolve => {
        const { stdin, stdout } = process;
        stdout.write(prompt);

        let input = '';
        const wasRaw = stdin.isRaw;
        const canSetRaw = typeof stdin.setRawMode === 'function';

        // Returns true once resolved, so the caller knows not to attach a
        // stream listener at all when the leftover buffer alone was enough.
        function consume(chunk) {
            for (let i = 0; i < chunk.length; i++) {
                const char = chunk[i];
                if (KEY_ENTER.has(char)) {
                    pendingInput = chunk.slice(i + 1); // carry over anything past this line
                    stdout.write('\n');
                    resolve(input);
                    return true;
                } else if (char === KEY_INTERRUPT) {
                    stdout.write('\n');
                    process.exit(130);
                } else if (KEY_BACKSPACE.has(char)) {
                    if (input.length > 0) {
                        input = input.slice(0, -1);
                        stdout.write('\b \b');
                    }
                } else {
                    input += char;
                    stdout.write(mask ? '*' : char);
                }
            }
            return false;
        }

        if (pendingInput) {
            const buffered = pendingInput;
            pendingInput = '';
            if (consume(buffered)) return;
        }

        if (canSetRaw) stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        function onData(chunk) {
            if (consume(chunk)) {
                // pendingInput is already a plain string at this point, captured
                // synchronously above — pausing the stream now can't lose it.
                // Skipping pause() would be the actual bug: with zero 'data'
                // listeners attached, a flowing-mode stream silently drops
                // whatever arrives next instead of buffering it, so anything
                // the OS delivers as a separate event before the next
                // readLine() call attaches its own listener would vanish.
                stdin.removeListener('data', onData);
                if (canSetRaw) stdin.setRawMode(wasRaw);
                stdin.pause();
            }
        }

        stdin.on('data', onData);
    });
}
