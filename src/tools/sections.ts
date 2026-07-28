/** Campaign sections — the page areas a campaign varies (used by MVT campaigns). */

import type { McpServer } from '@modelcontextprotocol/server';

import { registerCampaignResource } from './campaignResource.js';
import type { ToolContext } from './shared.js';

export function registerSectionTools(server: McpServer, ctx: ToolContext): void {
    registerCampaignResource(server, ctx, {
        segment: 'sections',
        idArg: 'sectionId',
        singular: 'section',
        plural: 'sections',
        tools: {
            list: 'vwo_list_campaign_sections',
            get: 'vwo_get_campaign_section',
            create: 'vwo_new_campaign_section',
            update: 'vwo_update_campaign_section',
            remove: 'vwo_delete_campaign_section'
        },
        docs: {
            create: 'https://developers.wingify.com/reference/create-a-campaign-section',
            update: 'https://developers.wingify.com/reference/update-a-campaign-section'
        },
        risk:
            'Sections determine which page areas the campaign varies, so changes affect what live ' +
            'visitors see and how combinations are reported.'
    });
}
