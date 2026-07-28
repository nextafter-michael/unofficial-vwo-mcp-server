/**
 * Workspaces — VWO's term for accounts and sub-accounts.
 *
 * Paths use `/accounts/...`; the UI and these tool names say "workspace".
 * `GET /accounts` returns sub-accounts only unless `includeCurrent` is set.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
    accountArgs,
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

export function registerWorkspaceTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_list_workspaces',
        {
            title: 'List VWO workspaces',
            description:
                'List the VWO workspaces (accounts and sub-accounts) this API token can access, ' +
                'with their ids and names. Call this whenever the user refers to a workspace by ' +
                'name and you need its id, or to see what is available. Never guess a workspace id.',
            inputSchema: z.object({
                includeCurrent: z
                    .boolean()
                    .default(true)
                    .describe(
                        "Include the token's own (main) workspace. VWO returns only secondary " +
                            'workspaces when false.'
                    ),
                status: z
                    .enum(['all', 'active', 'disabled'])
                    .default('all')
                    .describe('Filter by workspace status.')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_workspaces', async ({ includeCurrent, status }) => {
            const response = await ctx.client.get<VwoEnvelope>('/accounts', {
                includeCurrent: String(includeCurrent),
                status
            });
            const items = Array.isArray(response?._data) ? response._data : [];
            return jsonResult({
                count: items.length,
                defaultAccountId: ctx.config.accountId ?? null,
                restrictedTo: ctx.config.allowedAccountIds.length > 0 ? ctx.config.allowedAccountIds : null,
                workspaces: items
            });
        })
    );

    server.registerTool(
        'vwo_get_workspace',
        {
            title: 'Get VWO workspace details',
            description:
                'Get details of a single VWO workspace: name, timezone, company info, and whether ' +
                'it is enabled.',
            inputSchema: z.object({ ...accountArgs }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_workspace', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}`);
            return jsonResult({ account, workspace: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_new_workspace',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Create a VWO workspace',
            description:
                'Create a new VWO workspace (sub-account) under the authenticated account. ' +
                'Creates real, potentially billable state — confirm the name with the user first.',
            inputSchema: z.object({
                name: z.string().min(1).describe('Name for the new workspace.')
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
        },
        toolHandler('vwo_new_workspace', async ({ name }) => {
            const response = await ctx.client.post<VwoEnvelope>('/accounts', { name });
            return jsonResult({ created: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_update_workspace',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Update a VWO workspace',
            description:
                "Update a VWO workspace's name, timezone, company details, or enabled state. " +
                'Only the fields you pass are changed. Disabling a workspace stops its campaigns.',
            inputSchema: z.object({
                ...accountArgs,
                name: z.string().min(1).optional().describe('New workspace name.'),
                timezone: z.string().min(1).optional().describe('Timezone string, e.g. "Asia/Kolkata".'),
                enabled: z.boolean().optional().describe('Whether the workspace is enabled.'),
                company: z
                    .object({
                        name: z.string().optional(),
                        website: z.string().optional(),
                        size: z.string().optional()
                    })
                    .optional()
                    .describe('Company metadata for the workspace.')
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler('vwo_update_workspace', async ({ accountId, workspaceName, ...fields }) => {
            const account = await resolveAccount(ctx, { accountId, workspaceName });
            const payload = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
            const response = await ctx.client.patch<VwoEnvelope>(`/accounts/${account}`, payload);
            return jsonResult({ account, updated: unwrapData(response) ?? payload });
        })
    );

    server.registerTool(
        'vwo_get_workspace_history',
        {
            title: 'Get VWO workspace timeline',
            description:
                'Retrieve the activity timeline (feed) for a workspace — who changed what and when. ' +
                'Use startTime/endTime to narrow the window when investigating a specific change.',
            inputSchema: z.object({
                ...accountArgs,
                limit: z.number().int().min(1).max(100).default(100).describe('Maximum number of entries.'),
                offset: paginationArgs.offset,
                startTime: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Unix timestamp (seconds) for the start of the window.'),
                endTime: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Unix timestamp (seconds) for the end of the window.')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler(
            'vwo_get_workspace_history',
            async ({ accountId, workspaceName, limit, offset, startTime, endTime }) => {
                const account = await resolveAccount(ctx, { accountId, workspaceName });
                const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/feeds`, {
                    limit,
                    offset,
                    startTime,
                    endTime
                });
                return listResult(response, { account, limit, offset });
            }
        )
    );
}
