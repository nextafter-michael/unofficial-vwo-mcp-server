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
            'and alter the data being collected.',
        bodyGuidance:
            'WRITE DOM changes as a `changes` string, NOT as `editorData`. Reading a variation returns ' +
            '`editorData` (VWO\'s internal op stack), but writing that back is rejected — `changes` is ' +
            'the write format and VWO converts it into `editorData` itself. Verified working shapes: ' +
            '`{"name":"Variation 1"}` to rename; ' +
            '`{"name":"Variation 1","changes":"<script>/* JS that mutates the page */</script>"}` to add ' +
            'changes; `{"isDisabled":false,"percentSplit":50}` to enable a variation and set its traffic ' +
            'share. Note a freshly created campaign leaves its Control `isDisabled:true, percentSplit:0`, ' +
            'so set both explicitly on the Control or the test has no baseline.'
    });
}
