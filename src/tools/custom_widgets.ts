/**
 * Custom widgets.
 *
 * VWO serves these from `/changesets` — not guessable from the tool names, and
 * confirmed against the live API. One endpoint here is uncertain; see
 * `vwo_update_custom_widgets` below.
 */

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

const widgetIdArg = {
    widgetId: z
        .number()
        .int()
        .positive()
        .describe('Custom widget (changeset) id. Call vwo_list_custom_widgets if you do not have it.')
} as const;

export function registerCustomWidgetTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_list_custom_widgets',
        {
            title: 'List VWO custom widgets',
            description:
                'List the custom widgets defined in a VWO workspace, with their ids. Use this to find ' +
                'a widget id before fetching or changing one.',
            inputSchema: z.object({ ...accountArgs, ...paginationArgs }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_custom_widgets', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/changesets`, {
                limit: args.limit,
                offset: args.offset
            });
            return listResult(response, { account, limit: args.limit, offset: args.offset });
        })
    );

    server.registerTool(
        'vwo_get_custom_widget',
        {
            title: 'Get VWO custom widget',
            description: 'Get the full definition of one custom widget in a VWO workspace.',
            inputSchema: z.object({ ...accountArgs, ...widgetIdArg }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_custom_widget', async ({ widgetId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/changesets/${widgetId}`);
            return jsonResult({ account, widgetId, widget: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_new_custom_widget',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Create a VWO custom widget',
            description: 'Create a new custom widget in a VWO workspace.',
            inputSchema: z.object({
                ...accountArgs,
                ...bodyArg(
                    'https://developers.wingify.com/reference/create-a-custom-widget',
                    'Definition of the custom widget to create.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
        },
        toolHandler('vwo_new_custom_widget', async ({ body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.post<VwoEnvelope>(`/accounts/${account}/changesets`, body);
            return jsonResult({ account, created: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_update_custom_widget',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Update a VWO custom widget',
            description:
                'Change an existing custom widget. Widgets can be linked to live campaigns, so edits ' +
                'may affect what visitors see.',
            inputSchema: z.object({
                ...accountArgs,
                ...widgetIdArg,
                ...bodyArg(
                    'https://developers.wingify.com/reference/update-a-custom-widget',
                    'Fields to change on the custom widget.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler('vwo_update_custom_widget', async ({ widgetId, body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.patch<VwoEnvelope>(
                `/accounts/${account}/changesets/${widgetId}`,
                body
            );
            return jsonResult({ account, widgetId, updated: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_delete_custom_widget',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Delete a VWO custom widget',
            description:
                'Permanently delete a custom widget. This cannot be undone, and will break any ' +
                'campaign still linked to it. Confirm the specific widget with the user first.',
            inputSchema: z.object({ ...accountArgs, ...widgetIdArg }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
        },
        toolHandler('vwo_delete_custom_widget', async ({ widgetId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.delete<VwoEnvelope>(`/accounts/${account}/changesets/${widgetId}`);
            return jsonResult({ account, widgetId, deleted: true, result: unwrapData(response) ?? null });
        })
    );

    server.registerTool(
        'vwo_create_custom_widgets',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Create VWO custom widgets in bulk',
            description:
                'Create several custom widgets in one request. Prefer this over repeated ' +
                'vwo_new_custom_widget calls, since VWO permits only 1 request per second.',
            inputSchema: z.object({
                ...accountArgs,
                ...bodyArg(
                    'https://developers.wingify.com/reference/create-bulk-custom-widgets',
                    'Bulk payload describing the widgets to create.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
        },
        toolHandler('vwo_create_custom_widgets', async ({ body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.post<VwoEnvelope>(`/accounts/${account}/changesets/bulk`, body);
            return jsonResult({ account, created: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_update_custom_widgets',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Update VWO custom widgets in bulk',
            description:
                'Change several custom widgets in one request. Widgets can be linked to live ' +
                'campaigns, so edits may affect what visitors see. ' +
                'CAUTION: the endpoint for this operation is inferred, not confirmed — VWO\'s docs ' +
                'page for it points at an unrelated attribute-list endpoint. Verify the result of the ' +
                'first call before relying on it, and report back if it fails.',
            inputSchema: z.object({
                ...accountArgs,
                ...bodyArg(
                    'https://developers.wingify.com/reference/update-bulk-custom-widgets',
                    'Bulk payload describing the widget changes.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler('vwo_update_custom_widgets', async ({ body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            // VWO's doc page for "update bulk custom widgets" shows
            // POST /accounts/{id}/attribute-list/{id}, which does not match the
            // operation. PATCH on the bulk changeset route exists and is
            // consistent with the single-widget PATCH, so it is used here.
            const response = await ctx.client.patch<VwoEnvelope>(`/accounts/${account}/changesets/bulk`, body);
            return jsonResult({ account, updated: unwrapData(response) });
        })
    );
}
