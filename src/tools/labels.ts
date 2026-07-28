/** Labels — workspace-level tags applied to campaigns. */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
    accountArgs,
    bodyArg,
    campaignIdArg,
    jsonResult,
    listResult,
    paginationArgs,
    REQUIRES_HUMAN_APPROVAL,
    resolveAccount,
    toolHandler,
    unwrapData,
    type ToolContext,
    type VwoEnvelope
} from './shared.js';

export function registerLabelTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_list_labels',
        {
            title: 'List VWO labels',
            description:
                'List all labels defined in a VWO workspace, with their ids. Use this to find a label ' +
                'id before applying it to a campaign, or to filter vwo_list_campaigns by label.',
            inputSchema: z.object({ ...accountArgs, ...paginationArgs }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_labels', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/labels`, {
                limit: args.limit,
                offset: args.offset
            });
            return listResult(response, { account, limit: args.limit, offset: args.offset });
        })
    );

    server.registerTool(
        'vwo_list_campaign_labels',
        {
            title: 'List labels on a VWO campaign',
            description: 'List the labels currently applied to one VWO campaign.',
            inputSchema: z.object({ ...accountArgs, ...campaignIdArg }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_campaign_labels', async ({ campaignId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.get<VwoEnvelope>(
                `/accounts/${account}/campaigns/${campaignId}/labels`
            );
            return jsonResult({ account, campaignId, labels: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_add_campaign_label',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Add labels to a VWO campaign',
            description:
                'Apply one or more existing labels to a VWO campaign. Labels are organisational only ' +
                'and do not affect what visitors see. Call vwo_list_labels first to get valid label ids.',
            inputSchema: z.object({
                ...accountArgs,
                ...campaignIdArg,
                ...bodyArg(
                    'https://developers.wingify.com/reference/add-labels-to-a-campaign',
                    'The label(s) to apply, typically by id.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
        },
        toolHandler('vwo_add_campaign_label', async ({ campaignId, body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.post<VwoEnvelope>(
                `/accounts/${account}/campaigns/${campaignId}/labels`,
                body
            );
            return jsonResult({ account, campaignId, added: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_delete_campaign_label',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Remove a label from a VWO campaign',
            description:
                'Remove one label from a VWO campaign. This detaches the label from the campaign; it ' +
                'does not delete the label from the workspace.',
            inputSchema: z.object({
                ...accountArgs,
                ...campaignIdArg,
                labelId: z
                    .number()
                    .int()
                    .positive()
                    .describe('Label id to remove. Call vwo_list_campaign_labels if you do not have it.')
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
        },
        toolHandler('vwo_delete_campaign_label', async ({ campaignId, labelId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.delete<VwoEnvelope>(
                `/accounts/${account}/campaigns/${campaignId}/labels/${labelId}`
            );
            return jsonResult({ account, campaignId, labelId, removed: true, result: unwrapData(response) ?? null });
        })
    );
}
