/**
 * Campaign goals — the conversions a campaign measures.
 *
 * VWO's reference documents update/delete under `/campaign/{id}/goals/{goalId}`
 * (singular "campaign"). That path 404s on the live API; the plural form used
 * here is the one that exists.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import { registerCampaignResource } from './campaignResource.js';
import type { ToolContext } from './shared.js';

export function registerGoalTools(server: McpServer, ctx: ToolContext): void {
    registerCampaignResource(server, ctx, {
        segment: 'goals',
        idArg: 'goalId',
        singular: 'goal',
        plural: 'goals',
        tools: {
            list: 'vwo_list_campaign_goals',
            get: 'vwo_get_campaign_goal',
            create: 'vwo_new_campaign_goal',
            update: 'vwo_update_campaign_goal',
            remove: 'vwo_delete_campaign_goal'
        },
        docs: {
            create: 'https://developers.wingify.com/reference/create-a-campaign-goal',
            update: 'https://developers.wingify.com/reference/update-a-campaign-goal'
        },
        risk:
            'Goals define what the experiment measures, so changing them on a running campaign ' +
            'affects reported results and can invalidate conclusions drawn so far.'
    });
}
