/**
 * Campaigns (experiments).
 *
 * Irregularities in VWO's API here, all confirmed against live routes:
 *  - `vwo_update_campaign` wraps its payload in a `campaigns` object.
 *  - `vwo_update_campaign_status` posts to `/campaigns/status` with NO campaign id in
 *    the path — it is a bulk operation keyed by ids in the body.
 *  - `GET /campaigns` returns its collection as `_data.partialCollection` with a
 *    `_data.totalCount`, but the SAME endpoint returns `_data` as a flat array once
 *    `status` is supplied. `extractCollection` in ./shared.ts normalizes both.
 *  - `status` is a real, enforced query parameter that VWO does not document.
 */

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

export function registerCampaignTools(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        'vwo_list_campaigns',
        {
            title: 'List VWO campaigns',
            description:
                'List campaigns (experiments) in a VWO workspace. Use this to discover campaign ids ' +
                'before calling any tool that operates on a specific campaign. Filter by type, ' +
                'platform, or label to narrow large accounts.',
            inputSchema: z.object({
                ...accountArgs,
                ...paginationArgs,
                // Overrides paginationArgs.limit (max 100) deliberately: VWO caps
                // THIS endpoint at 25 server-side — verified, limit=50 and
                // limit=100 both return 25. Leaving the max at 100 broke paging,
                // because `items.length === limit` never held on a full page, so
                // nextOffset came back null and callers stopped after one page.
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(25)
                    .default(25)
                    .describe(
                        'Maximum campaigns to return. VWO caps this endpoint at 25 regardless of what ' +
                            'you request, so page through with offset/nextOffset rather than a bigger limit.'
                    ),
                type: z
                    .string()
                    .optional()
                    .describe(
                        'Filter by campaign type. VWO\'s values are lowercase and hyphenated, not the ' +
                            'generic A/B-testing names they resemble: "ab", "split" (Split URL), ' +
                            '"multivariate" (not "mvt"), "feature-rollout" (Web Rollout), "feature-test", ' +
                            'plus non-testing types like "heatmap", "survey", "recording".'
                    ),
                platform: z
                    .string()
                    .optional()
                    .describe('Filter by platform: "website", "full-stack", or "mobile-app" (not "WEB"/"FULLSTACK").'),
                status: z
                    .enum(['ACTIVE', 'DELETED', 'ARCHIVED', 'RUNNING', 'PAUSED', 'STOPPED', 'NOT_STARTED'])
                    .optional()
                    .describe(
                        'Filter by campaign status. UPPERCASE only — VWO rejects lowercase with HTTP 400. ' +
                            'Omit to get campaigns of every status (which is usually what you want; note ' +
                            'that includes DELETED ones, so check each result\'s own `status` field before ' +
                            'reporting a campaign as live). This parameter is absent from VWO\'s published ' +
                            'docs but is real and enforced — the valid values above come from the error ' +
                            "message VWO returns for an invalid one."
                    ),
                label: z.string().optional().describe('Filter by label name.'),
                projectId: z.number().int().positive().optional().describe('Filter by project id.'),
                showDetailedInfo: z
                    .boolean()
                    .optional()
                    .describe('Return the full campaign objects instead of a summary. Much larger responses.')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_list_campaigns', async args => {
            const account = await resolveAccount(ctx, args);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/campaigns`, {
                limit: args.limit,
                offset: args.offset,
                type: args.type,
                platform: args.platform,
                status: args.status,
                label: args.label,
                projectId: args.projectId,
                showDetailedInfo: args.showDetailedInfo
            });
            return listResult(response, { account, limit: args.limit, offset: args.offset });
        })
    );

    server.registerTool(
        'vwo_get_campaign',
        {
            title: 'Get VWO campaign details',
            description:
                'Get the full configuration of one campaign: type, status, URLs, goals, variations, ' +
                'and targeting.',
            inputSchema: z.object({ ...accountArgs, ...campaignIdArg }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_campaign', async ({ campaignId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.get<VwoEnvelope>(`/accounts/${account}/campaigns/${campaignId}`);
            return jsonResult({ account, campaignId, campaign: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_get_campaign_share_link',
        {
            title: 'Get VWO campaign share link',
            description:
                'Get a shareable report link for a campaign, for sending results to someone without ' +
                'a VWO login.',
            inputSchema: z.object({ ...accountArgs, ...campaignIdArg }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        toolHandler('vwo_get_campaign_share_link', async ({ campaignId, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.get<VwoEnvelope>(
                `/accounts/${account}/campaigns/${campaignId}/share`
            );
            return jsonResult({ account, campaignId, share: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_new_campaign',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Create a VWO campaign',
            description:
                'Create a new campaign (experiment) in a VWO workspace. Creates real state that can ' +
                'affect live traffic once started, so confirm type, URLs, and goals with the user before ' +
                'calling — do not create campaigns speculatively or to explore the API. ' +
                'New campaigns start at status NOT_STARTED (a draft) and do NOT run until explicitly ' +
                'started, so creating one is safe from a traffic standpoint. ' +
                'IMPORTANT follow-up: VWO creates the campaign with ONLY a Control variation, left ' +
                'disabled at percentSplit 0. Adding a variation does not fix the Control. After creating, ' +
                'read the campaign back and set the Control\'s isDisabled/percentSplit explicitly, or the ' +
                'test has no baseline.',
            inputSchema: z.object({
                ...accountArgs,
                type: z
                    .string()
                    .min(1)
                    .describe(
                        'Campaign type — lowercase, hyphenated. Common values: "ab", "split" (Split ' +
                            'URL), "multivariate" (not "mvt"), "feature-rollout" (Web Rollout), ' +
                            '"feature-test". Not the generic "AB"/"SPLIT_URL"/"MVT" naming.'
                    ),
                primaryUrl: z
                    .string()
                    .min(1)
                    .describe('Primary URL the campaign runs on — the page opened in VWO\'s visual editor.'),
                urls: z
                    .array(
                        z.object({
                            type: z
                                .string()
                                .default('url')
                                .describe('Match type. "url" matches that address; VWO also accepts pattern types.'),
                            value: z.string().min(1).describe('The URL or pattern to match.')
                        })
                    )
                    .min(1)
                    .describe(
                        'Pages the campaign targets. Verified working shape: ' +
                            '[{"type":"url","value":"https://www.example.com"}]. Usually one entry matching ' +
                            'primaryUrl; add more to widen targeting.'
                    ),
                goals: z
                    .array(
                        z.object({
                            name: z.string().min(1).describe('Human-readable goal name.'),
                            type: z
                                .string()
                                .default('visitPage')
                                .describe(
                                    'Goal type: "visitPage", "engagement", "formSubmit", or ' +
                                        '"custom-conversion". VWO normalizes some of these on save.'
                                ),
                            urls: z
                                .array(
                                    z.object({
                                        type: z.string().default('url'),
                                        value: z.string().min(1)
                                    })
                                )
                                .describe('URLs the goal is measured against, same shape as the campaign `urls`.')
                        })
                    )
                    .min(1)
                    .describe(
                        'At least one goal is REQUIRED — VWO refuses to create a campaign without one, even ' +
                            'for a test that will never be started. Verified working shape: ' +
                            '[{"name":"Thank-you page visit","type":"visitPage",' +
                            '"urls":[{"type":"url","value":"https://www.example.com/thanks"}]}]. If the user ' +
                            'has not said what defines success, ask rather than inventing a metric — or, if ' +
                            'they only want a draft, add one clearly-labeled placeholder goal and say so.'
                    ),
                name: z
                    .string()
                    .min(1)
                    .optional()
                    .describe('Campaign name. Always worth setting — VWO otherwise auto-names it "Campaign <n>".')
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
        },
        toolHandler('vwo_new_campaign', async ({ accountId, workspaceName, ...fields }) => {
            const account = await resolveAccount(ctx, { accountId, workspaceName });
            const payload = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
            const response = await ctx.client.post<VwoEnvelope>(`/accounts/${account}/campaigns`, payload);
            return jsonResult({ account, created: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_update_campaign',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Update a VWO campaign',
            description:
                'Update the configuration of an existing campaign. Changes can affect a live ' +
                'experiment and its collected data. Pass only the fields you intend to change.',
            inputSchema: z.object({
                ...accountArgs,
                ...campaignIdArg,
                ...bodyArg(
                    'https://developers.wingify.com/reference/update-a-campaign',
                    'Fields to change on the campaign. VWO expects these wrapped in a `campaigns` ' +
                        'object; this tool adds that wrapper for you, so pass the fields directly.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler('vwo_update_campaign', async ({ campaignId, body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            // VWO requires the `campaigns` wrapper; adding it here keeps the tool
            // surface flat for the model, which gets this wrong when asked to nest.
            const payload = 'campaigns' in body ? body : { campaigns: body };
            const response = await ctx.client.patch<VwoEnvelope>(
                `/accounts/${account}/campaigns/${campaignId}`,
                payload
            );
            return jsonResult({ account, campaignId, updated: unwrapData(response) });
        })
    );

    server.registerTool(
        'vwo_update_campaign_status',
        {
            ...REQUIRES_HUMAN_APPROVAL,
            title: 'Update VWO campaign status',
            description:
                'Start, pause, or stop campaigns. This directly changes what live visitors see and ' +
                'can end data collection — always confirm the campaign and target status with the ' +
                'user first. Note this is a bulk endpoint: VWO takes the campaign ids in the body.',
            inputSchema: z.object({
                ...accountArgs,
                ...bodyArg(
                    'https://developers.wingify.com/reference/update-a-campaign-1',
                    'Status change payload: the campaign id(s) and the desired status. Statuses VWO ' +
                        'accepts are RUNNING, PAUSED, STOPPED, NOT_STARTED, ARCHIVED, DELETED, and ACTIVE. ' +
                        'This is also how a campaign gets removed — there is no DELETE endpoint for ' +
                        'campaigns; setting DELETED soft-deletes it (it still appears under ' +
                        'vwo_list_campaigns with isDeleted true, and via status=DELETED). Treat DELETED and ' +
                        'ARCHIVED as destructive: never send them unless the user explicitly asked to ' +
                        'delete or archive that specific campaign.'
                )
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        toolHandler('vwo_update_campaign_status', async ({ body, ...rest }) => {
            const account = await resolveAccount(ctx, rest);
            const response = await ctx.client.patch<VwoEnvelope>(`/accounts/${account}/campaigns/status`, body);
            return jsonResult({ account, result: unwrapData(response) ?? 'status update accepted' });
        })
    );
}
