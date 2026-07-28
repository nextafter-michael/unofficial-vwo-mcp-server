/** SmartCode — the tracking snippet a workspace installs on its site. */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { accountArgs, jsonResult, resolveAccount, toolHandler, unwrapData, type ToolContext, type VwoEnvelope } from './shared.js';

export function registerTrackingCodeTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_get_smartcode',
        {
            title: 'Get VWO SmartCode',
            description:
                'Get the VWO SmartCode tracking snippet for a workspace — the JavaScript that must be ' +
                'installed on the site for campaigns to run. Use this when helping someone verify or ' +
                'install tracking.',
            inputSchema: z.object({ ...accountArgs }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_smartcode', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/smartcode`);
            return jsonResult({ account, smartcode: unwrapData(response) });
        })
    );
}
