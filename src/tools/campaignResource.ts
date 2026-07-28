/**
 * Factory for campaign sub-resources.
 *
 * Goals, variations, and sections are the same five operations over
 * `/accounts/{account}/campaigns/{campaignId}/<segment>`, so the shape lives
 * here once and each module supplies its own names, doc links, and — importantly
 * — its own risk wording, since pausing a variation and deleting a goal are not
 * equally consequential.
 */

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
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

export interface CampaignResourceSpec {
    /** URL segment, e.g. `goals`. */
    segment: string;
    /** Argument name for the resource id, e.g. `goalId`. */
    idArg: string;
    /** Singular human label, e.g. `goal`. */
    singular: string;
    /** Plural human label, e.g. `goals`. */
    plural: string;
    tools: { list: string; get: string; create: string; update: string; remove: string };
    docs: { create: string; update: string };
    /** Extra sentence appended to the create/update/delete descriptions. */
    risk: string;
    /**
     * Concrete, verified-against-the-live-API guidance about this resource's
     * request body, so an agent can construct one without fetching VWO's docs.
     * Prepended to the generic `body` description. Omit if there is nothing
     * resource-specific worth saying.
     */
    bodyGuidance?: string;
}

/**
 * VWO requires every campaign sub-resource write to be wrapped in the plural
 * resource name — `{"goals": {...}}`, `{"variations": {...}}`,
 * `{"sections": {...}}` — which happens to be exactly `spec.segment`. An
 * unwrapped body is rejected with `HTTP 400 "Request is not in desired
 * format."` (hit live against the variations endpoint).
 *
 * Wrapping here rather than asking the caller to do it matches what
 * `vwo_update_campaign` already does with its `campaigns` wrapper, and for the
 * same stated reason: models reliably get nesting like this wrong. An
 * already-wrapped body is passed through untouched so an explicitly-correct
 * payload never gets double-wrapped.
 */
function wrapBody(segment: string, body: Record<string, unknown>): Record<string, unknown> {
    return segment in body ? body : { [segment]: body };
}

export function registerCampaignResource(server: McpServer, ctx: ToolContext, spec: CampaignResourceSpec): void {
    const idArg = {
        [spec.idArg]: z
            .number()
            .int()
            .positive()
            .describe(`VWO ${spec.singular} id. Call ${spec.tools.list} first if you do not have it.`)
    };

    const basePath = (account: number | string, campaignId: number) =>
        `/accounts/${account}/campaigns/${campaignId}/${spec.segment}`;

    server.registerTool(
        spec.tools.list,
        {
            title: `List VWO campaign ${spec.plural}`,
            description: `List the ${spec.plural} configured on a VWO campaign. Use this to discover ${spec.singular} ids.`,
            inputSchema: z.object({ ...accountArgs, ...campaignIdArg, ...paginationArgs }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler(spec.tools.list, async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(basePath(account, args.campaignId), {
                limit: args.limit,
                offset: args.offset
            });
            return listResult(response, {
                account,
                campaignId: args.campaignId,
                limit: args.limit,
                offset: args.offset
            });
        })
    );

    server.registerTool(
        spec.tools.get,
        {
            title: `Get VWO campaign ${spec.singular}`,
            description: `Get the full configuration of one ${spec.singular} on a VWO campaign.`,
            inputSchema: z.object({ ...accountArgs, ...campaignIdArg, ...idArg }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler(spec.tools.get, async (args: Record<string, unknown>) => {
            const { campaignId } = args as { campaignId: number };
            const resourceId = args[spec.idArg] as number;
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`${basePath(account, campaignId)}/${resourceId}`);
            return jsonResult({
                account,
                campaignId,
                [spec.idArg]: resourceId,
                [spec.singular]: unwrapData(response)
            });
        })
    );

    server.registerTool(
        spec.tools.create,
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: `Create a VWO campaign ${spec.singular}`,
            description: `Add a new ${spec.singular} to a VWO campaign. ${spec.risk}`,
            inputSchema: z.object({
                ...accountArgs,
                ...campaignIdArg,
                ...bodyArg(
                    spec.docs.create,
                    `Definition of the ${spec.singular} to create. Pass the fields directly — this tool ` +
                        `adds the \`${spec.segment}\` wrapper VWO requires.` +
                        (spec.bodyGuidance ? ` ${spec.bodyGuidance}` : '')
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
        },
        toolHandler(spec.tools.create, async ({ campaignId, body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.post<VwoEnvelope>(
                basePath(account, campaignId),
                wrapBody(spec.segment, body)
            );
            return jsonResult({ account, campaignId, created: unwrapData(response) });
        })
    );

    server.registerTool(
        spec.tools.update,
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: `Update a VWO campaign ${spec.singular}`,
            description: `Change an existing ${spec.singular} on a VWO campaign. ${spec.risk}`,
            inputSchema: z.object({
                ...accountArgs,
                ...campaignIdArg,
                ...idArg,
                ...bodyArg(
                    spec.docs.update,
                    `Fields to change on the ${spec.singular}. Pass the fields directly — this tool adds ` +
                        `the \`${spec.segment}\` wrapper VWO requires.` +
                        (spec.bodyGuidance ? ` ${spec.bodyGuidance}` : '')
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler(spec.tools.update, async (args: Record<string, unknown>) => {
            const { campaignId, body } = args as { campaignId: number; body: Record<string, unknown> };
            const resourceId = args[spec.idArg] as number;
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.patch<VwoEnvelope>(
                `${basePath(account, campaignId)}/${resourceId}`,
                wrapBody(spec.segment, body)
            );
            return jsonResult({ account, campaignId, [spec.idArg]: resourceId, updated: unwrapData(response) });
        })
    );

    server.registerTool(
        spec.tools.remove,
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: `Delete a VWO campaign ${spec.singular}`,
            description:
                `Permanently delete a ${spec.singular} from a VWO campaign. This cannot be undone. ` +
                `${spec.risk} Confirm the specific ${spec.singular} with the user before calling.`,
            inputSchema: z.object({ ...accountArgs, ...campaignIdArg, ...idArg }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
        },
        toolHandler(spec.tools.remove, async (args: Record<string, unknown>): Promise<CallToolResult> => {
            const { campaignId } = args as { campaignId: number };
            const resourceId = args[spec.idArg] as number;
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.delete<VwoEnvelope>(`${basePath(account, campaignId)}/${resourceId}`);
            return jsonResult({
                account,
                campaignId,
                [spec.idArg]: resourceId,
                deleted: true,
                result: unwrapData(response) ?? null
            });
        })
    );
}
