import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { ToolContext } from '../tools/shared.js';
import { promptResult } from './shared.js';

const GUIDANCE = `# Working with the VWO MCP server

House rules that apply across every VWO tool call, not just one situation.

## Resolving a workspace (account)

This token may manage several client workspaces. Never guess an id:

1. If the user named a workspace, either pass \`workspaceName\` on the tool call directly,
   or call \`vwo_list_workspaces\` first if you need to disambiguate or confirm.
2. If no workspace is named and the server has no default (\`VWO_ACCOUNT_ID\` unset), tools
   will refuse with an explicit error rather than silently picking one. Call
   \`vwo_list_workspaces\`, show the user the options, and ask if more than one plausible
   match exists.
3. A configured \`VWO_ALLOWED_ACCOUNT_IDS\` allow-list is a deliberate operator restriction.
   If a tool refuses an account id for this reason, tell the user — don't try other ids.

## Read vs. write tools

Every tool name says which it is: \`vwo_list_*\` and \`vwo_get_*\` are read-only. Everything
starting \`vwo_new_\`, \`vwo_create_\`, \`vwo_add_\`, \`vwo_update_\`, or \`vwo_delete_\` changes
real state and requires human approval in hosts that enforce it — expect and wait for that
prompt rather than treating it as a failure.

Because approval is per-call, make each write call represent ONE understandable change.
State what you're about to do and why before making the call, so the person approving it
knows what they're agreeing to. Don't bundle several unrelated edits into one call just to
save round trips.

## Rate limits

VWO permits 1 request/second per token; this server already paces outbound requests to
respect that, so you don't need to add your own delays. But avoid redundant calls — if you
already fetched a campaign or variation this turn and nothing you did could have changed
it, reuse what you have rather than re-fetching.

## Creating and deleting campaigns

**Creating** a campaign is safe from a traffic standpoint — new campaigns are drafts
(\`NOT_STARTED\`) and serve nobody until explicitly started. But a real object appears in the
user's account, so be discerning: create one because the user asked for it, never speculatively
or to explore the API.

**Deleting** is possible but is the user's call. VWO has no campaign DELETE endpoint; removal
means setting the status to \`DELETED\` (or \`ARCHIVED\`) via \`vwo_update_campaign_status\`, which
soft-deletes it. Treat those two statuses as destructive and never send them unless the user
explicitly asked to remove that specific campaign. If you created something by mistake, say so
and offer to delete it — don't silently clean up, and don't pretend it can't be undone.

## Campaign status is a separate concern from campaign content

Changing what a variation shows (\`vwo_update_campaign_variation\`) is a different action
from starting, pausing, or stopping a campaign (\`vwo_update_campaign_status\`). Editing
content never implies a status change — don't touch status unless the user asked for that
specifically.

## Editing a live campaign

Don't edit a running campaign's variations or properties ad hoc. Use one of the workflow
prompts — each fetches the campaign's current state for you, and prescribes a specific
inspect → plan → apply → visually verify → iterate loop:

- \`vwo_ab_test_workflow\` — same-page content/DOM changes (type \`ab\`, or \`multivariate\`).
- \`vwo_split_test_workflow\` — a distinct destination URL per variation (type \`split\`).
  Simpler than the A/B workflow: no code to inspect, just which URL each variation points to.
- \`vwo_web_rollout_workflow\` — shipping a change to some or all visitors with no control
  and no analytical goal (type \`feature-rollout\`). Mechanically identical to the A/B
  workflow otherwise.

All three include how to check the change actually took effect using a browser automation
tool, if one is available in this session — and are explicit about what to do (and say)
when one isn't.

## Request body shapes (so you don't need VWO's docs for the common cases)

Every shape below was verified against the live API. Prefer these over guessing or fetching docs.

**Wrappers are added for you.** VWO requires campaign-resource writes to be wrapped in the plural
resource name (\`{"campaigns":…}\`, \`{"goals":…}\`, \`{"variations":…}\`, \`{"sections":…}\`), and an
unwrapped body is rejected with \`HTTP 400 "Request is not in desired format."\` The tools add the
wrapper themselves — **pass the fields directly**. If you pass an already-wrapped body it's left
alone, so either works, but flat is simpler.

**Creating a campaign** (\`vwo_new_campaign\`) — \`urls\` and \`goals\` are both required:

\`\`\`
type: "ab"                     // or "split", "multivariate", "feature-rollout"
primaryUrl: "https://example.com"
urls:  [{ "type": "url", "value": "https://example.com" }]
goals: [{ "name": "Thank-you page visit", "type": "visitPage",
          "urls": [{ "type": "url", "value": "https://example.com/thanks" }] }]
\`\`\`

**Variation DOM changes** — write a \`changes\` string, NOT \`editorData\`. This trips people up:
*reading* a variation returns \`editorData\` (VWO's internal op stack), but writing that back is
rejected. \`changes\` is the write format; VWO converts it into \`editorData\` itself.

\`\`\`
{ "name": "Variation 1", "changes": "<script>/* JS that mutates the page */</script>" }
{ "isDisabled": false, "percentSplit": 50 }        // enable a variation / set traffic share
\`\`\`

**A brand-new campaign is not a working test yet.** VWO creates only a Control, disabled at
\`percentSplit: 0\`, and adding a variation does not change that. Read the campaign back after
creating and set the Control's \`isDisabled\`/\`percentSplit\` explicitly, or the test has no
baseline. The workflow prompts walk through this.

For anything not covered above, each write tool's \`body\` description carries the exact VWO doc
URL for that endpoint.

## Technical or platform questions about VWO itself

If the user asks how VWO's platform actually behaves — not "do X with my campaign" but "how
does VWO handle Y" — for example: *"do the UTM parameters from the control page get
appended to the treatment URL when VWO routes a visitor into that variation of a split
test?"* — no tool in this server can answer that. These tools call VWO's REST API; none of
them expose VWO's internal redirect, tracking, or cookie-bucketing behavior.

Search VWO's own support and documentation sites for an authoritative answer (its help
center and the API reference at developers.wingify.com/help.vwo.com) rather than answering
from general A/B-testing knowledge or from how this server's tools happen to be shaped —
several assumptions that looked reasonable turned out to be wrong when actually checked
against VWO's docs while building this server (campaign type names, the shape of the
"share link," the campaign-deletion story). If you have no web search or fetch capability
in this session, say so plainly and tell the user you could not verify the answer, rather
than presenting an educated guess as settled fact.`;

export function registerGeneralGuidancePrompt(server: McpServer, _ctx: ToolContext): void {
    server.registerPrompt(
        'vwo_general_guidance',
        {
            title: 'VWO server: general guidance',
            description:
                'House rules for working with this VWO server: resolving workspaces safely, what ' +
                'requires approval, rate limits, which workflow prompt to use for editing a live ' +
                'campaign, and to check VWO\'s own docs for platform-behavior questions rather than ' +
                'guessing. Read this once at the start of a VWO-related task.',
            argsSchema: z.object({})
        },
        () => promptResult(GUIDANCE, 'General guidance for using the VWO MCP server')
    );
}
