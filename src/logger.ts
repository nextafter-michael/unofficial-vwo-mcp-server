/**
 * stderr-only logging.
 *
 * IMPORTANT: on a stdio MCP server, stdout is the JSON-RPC channel. Writing
 * anything else to it corrupts the framing and the host drops the connection.
 * Never use `console.log` in this project — use these helpers.
 */

import { redact } from './redact.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = levels[(process.env['VWO_LOG_LEVEL'] as Level | undefined) ?? 'info'] ?? levels.info;

function emit(level: Level, message: string, detail?: unknown): void {
    if (levels[level] < threshold) {
        return;
    }
    const parts = [`[vwo-mcp] ${level.toUpperCase()} ${redact(message)}`];
    if (detail !== undefined) {
        parts.push(redact(typeof detail === 'string' ? detail : JSON.stringify(detail)));
    }
    process.stderr.write(`${parts.join(' ')}\n`);
}

export const log = {
    debug: (message: string, detail?: unknown) => emit('debug', message, detail),
    info: (message: string, detail?: unknown) => emit('info', message, detail),
    warn: (message: string, detail?: unknown) => emit('warn', message, detail),
    error: (message: string, detail?: unknown) => emit('error', message, detail)
};
