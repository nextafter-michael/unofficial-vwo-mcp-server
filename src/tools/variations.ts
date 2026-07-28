/** Campaign variations — the alternatives shown to visitors. */

import type { McpServer } from '@modelcontextprotocol/server';

import { registerCampaignResource } from './campaignResource.js';
import type { ToolContext } from './shared.js';

export function registerVariationTools(server: McpServer, ctx: ToolContext): void {
    registerCampaignResource(server, ctx, {
        segment: 'variations',
        idArg: 'variationId',
        singular: 'variation',
        plural: 'variations',
        tools: {
            list: 'vwo_list_campaign_variations',
            get: 'vwo_get_campaign_variation',
            create: 'vwo_new_campaign_variation',
            update: 'vwo_update_campaign_variation',
            remove: 'vwo_delete_campaign_variation'
        },
        docs: {
            create: 'https://developers.wingify.com/reference/create-a-campaign-variation',
            update: 'https://developers.wingify.com/reference/update-a-campaign-variation'
        },
        risk:
            'Variations are what live visitors actually see, so changes take effect on real traffic ' +
            'and alter the data being collected.'
    });
}
