/** Draft campaigns — campaigns not yet published. */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
    accountArgs,
    bodyArg,
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

const draftIdArg = {
    draftId: z.number().int().positive().describe('VWO draft campaign id. Call vwo_list_drafts if you do not have it.')
} as const;

export function registerDraftTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_list_drafts',
        {
            title: 'List VWO draft campaigns',
            description:
                'List unpublished draft campaigns in a VWO workspace. Drafts are not live and affect ' +
                'no visitors.',
            inputSchema: z.object({ ...accountArgs, ...paginationArgs }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_drafts', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/drafts`, {
                limit: args.limit,
                offset: args.offset
            });
            return listResult(response, { account, limit: args.limit, offset: args.offset });
        })
    );

    server.registerTool(
        'vwo_get_draft',
        {
            title: 'Get VWO draft campaign',
            description: 'Get the full configuration of a single draft campaign.',
            inputSchema: z.object({ ...accountArgs, ...draftIdArg }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_draft', async ({ draftId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/drafts/${draftId}`);
            return jsonResult({ account, draftId, draft: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_update_draft_campaigns',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Update a VWO draft campaign',
            description:
                'Update a draft campaign\'s configuration. Drafts are not live, so this does not ' +
                'affect visitors, but it does overwrite the saved draft.',
            inputSchema: z.object({
                ...accountArgs,
                ...draftIdArg,
                ...bodyArg(
                    'https://developers.wingify.com/reference/update-draft-of-current--sub-account',
                    'Fields to change on the draft campaign.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler('vwo_update_draft_campaigns', async ({ draftId, body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.patch<VwoEnvelope>(`/accounts/${account}/drafts/${draftId}`, body);
            return jsonResult({ account, draftId, updated: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_delete_draft_campaigns',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Delete a VWO draft campaign',
            description:
                'Permanently delete a draft campaign. This cannot be undone — confirm the specific ' +
                'draft with the user, by name, before calling.',
            inputSchema: z.object({ ...accountArgs, ...draftIdArg }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
        },
        toolHandler('vwo_delete_draft_campaigns', async ({ draftId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.delete<VwoEnvelope>(`/accounts/${account}/drafts/${draftId}`);
            return jsonResult({ account, draftId, deleted: true, result: unwrapData(response) ?? null });
        })
    );
}
