import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { verifyConnection } from '../vwo/verify.js';
import { jsonResult, toolHandler, type ToolContext } from './shared.js';

export function registerDiagnosticTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_verify_connection',
        {
            title: 'Verify VWO connection',
            description:
                'Check that the VWO MCP server is correctly configured and its API token works, by ' +
                'making one lightweight authenticated request. Returns the base URL, token source, ' +
                'and a token fingerprint — never the token itself. Call this first when other VWO ' +
                'tools return authorization errors.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_verify_connection', async () => {
            const result = await verifyConnection(ctx.accounts, ctx.config);
            return jsonResult(result);
        })
    );
}
