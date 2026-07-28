/** Metric reports — VWO Insights metrics. Served from `/insights-metrics`. */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
    accountArgs,
    jsonResult,
    listResult,
    paginationArgs,
    resolveAccount,
    toolHandler,
    unwrapData,
    type ToolContext,
    type VwoEnvelope
} from './shared.js';

export function registerMetricReportTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_list_metric_reports',
        {
            title: 'List VWO metric reports',
            description:
                'List the VWO Insights metric reports configured in a workspace. Use this to find a ' +
                'report id before fetching its details.',
            inputSchema: z.object({
                ...accountArgs,
                ...paginationArgs,
                status: z.string().optional().describe('Filter by report status.'),
                order: z.string().optional().describe('Sort order for the results, as accepted by VWO.')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_metric_reports', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/insights-metrics`, {
                limit: args.limit,
                offset: args.offset,
                status: args.status,
                order: args.order
            });
            return listResult(response, { account, limit: args.limit, offset: args.offset });
        })
    );

    server.registerTool(
        'vwo_get_metric_report',
        {
            title: 'Get VWO metric report',
            description: 'Get the details of one VWO Insights metric report by its id.',
            inputSchema: z.object({
                ...accountArgs,
                reportId: z
                    .number()
                    .int()
                    .positive()
                    .describe('Metric report id. Call vwo_list_metric_reports if you do not have it.')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_metric_report', async ({ reportId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.get<VwoEnvelope>(
                `/accounts/${account}/insights-metrics/${reportId}`
            );
            return jsonResult({ account, reportId, report: unwrapData(response) });
        })
    );
}
