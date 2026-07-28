#!/usr/bin/env node
/**
 * Entry point for the unofficial VWO MCP server (stdio transport).
 *
 * Two modes:
 *   node dist/index.js            serve MCP over stdio
 *   node dist/index.js --verify   check config + credentials, print, exit
 *
 * Config is loaded once here, before the server exists, so a misconfigured
 * process fails loudly at startup instead of failing per tool call.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { ConfigError, loadConfig, type Config } from './config.js';
import { log } from './logger.js';
import { registerAllPrompts } from './prompts/index.js';
import { redactError } from './redact.js';
import { registerAllTools, type ToolContext } from './tools/index.js';
import { AccountDirectory } from './vwo/accounts.js';
import { VwoClient } from './vwo/client.js';
import { verifyConnection } from './vwo/verify.js';

const SERVER_INFO = { name: 'unofficial-vwo-mcp-server', version: '0.1.0' } as const;

/**
 * Sent to the client at connect time, before any tool call. Kept short since
 * it's always-on context cost, unlike a prompt which only loads when asked
 * for. The fuller reference lives in the `vwo_general_guidance` prompt.
 */
const SERVER_INSTRUCTIONS =
    'This server manages a VWO account that may have multiple client workspaces — never ' +
    'guess a workspace id; resolve it via vwo_list_workspaces or an explicit workspaceName. ' +
    'Tools named vwo_new_*/vwo_create_*/vwo_add_*/vwo_update_*/vwo_delete_* change real VWO ' +
    'state and require human approval; vwo_list_*/vwo_get_* are read-only. Before editing a ' +
    'live campaign, use vwo_ab_test_workflow, vwo_split_test_workflow, or ' +
    "vwo_web_rollout_workflow (matching the campaign's type) rather than editing ad hoc — " +
    "each fetches the campaign's current state and prescribes a verify-before-done loop. " +
    'For questions about how VWO itself behaves rather than what to do with a campaign, ' +
    "search VWO's own support/docs instead of guessing. Campaign-resource write bodies are " +
    'wrapped for you (pass fields directly), and variation DOM edits are written as a ' +
    '`changes` string, never as the `editorData` you get back when reading. Deleting a ' +
    'campaign means setting status DELETED/ARCHIVED — only ever on explicit user request. ' +
    'See the vwo_general_guidance prompt for the full reference.';

function buildContext(config: Config): ToolContext {
    const client = new VwoClient(config);
    return { client, config, accounts: new AccountDirectory(client, config) };
}

/** `--verify`: human-facing preflight. Prints to stderr; exit code is the signal. */
async function runVerify(config: Config): Promise<void> {
    const { accounts } = buildContext(config);
    const result = await verifyConnection(accounts, config);
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(
        result.ok
            ? '\nOK — VWO credentials work and the API is reachable.\n'
            : '\nFAILED — see "error" and "hint" above.\n'
    );

    // Set the code and let the event loop drain rather than calling
    // process.exit(): on Windows, exiting while fetch's sockets are still
    // closing trips a libuv assertion (`UV_HANDLE_CLOSING`) and the process
    // dies with 127, making the exit code useless for scripting.
    process.exitCode = result.ok ? 0 : 1;
}

async function main(): Promise<void> {
    let config: Config;
    try {
        config = loadConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            // Actionable, no stack trace — this is a user configuration problem.
            process.stderr.write(`\n[vwo-mcp] Configuration error: ${error.message}\n\n`);
            process.exit(78); // EX_CONFIG
        }
        throw error;
    }

    if (process.argv.includes('--verify')) {
        await runVerify(config);
        return;
    }

    // One factory, invoked per connection. Tools are registered on each
    // instance; the client is shared so the rate-limit gate is process-wide.
    const ctx = buildContext(config);

    serveStdio(
        () => {
            const server = new McpServer(SERVER_INFO, {
                capabilities: { tools: {}, prompts: {} },
                instructions: SERVER_INSTRUCTIONS
            });
            registerAllTools(server, ctx);
            registerAllPrompts(server, ctx);
            return server;
        },
        { onerror: error => log.error('Transport error', redactError(error)) }
    );

    log.info(`${SERVER_INFO.name} v${SERVER_INFO.version} listening on stdio.`);
}

main().catch((error: unknown) => {
    log.error('Fatal error during startup', redactError(error));
    process.exit(1);
});
