/**
 * The workflow for creating or editing a Web Rollout.
 *
 * A Web Rollout is mechanically the same as an A/B test — same-page DOM/JS/CSS
 * changes via `editorData`, same live-preview verification — with two
 * differences: no control variation (the rollout ships one variation to some
 * or all visitors, it doesn't compare against a baseline) and no analytical
 * goal (nothing is being measured). Confirmed against VWO's own API: the
 * `type` enum on `GET /campaigns` includes the literal value
 * `"feature-rollout"`, distinct from `"ab"`.
 *
 * The one place this can't be fully clean: VWO's create-campaign endpoint
 * requires a `goals` key in the request body regardless of campaign type.
 * Its documented schema shows no minimum array length, so this prompt has the
 * model try an empty array first — but that absence of a documented
 * constraint isn't a guarantee VWO's server-side validation agrees, so it
 * also gives a fallback.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { redactError } from '../redact.js';
import type { ToolContext } from '../tools/shared.js';
import {
    buildEditorDataUnderstandSection,
    buildSnapshotSection,
    buildVerificationSection,
    NO_DELETE_CAMPAIGN_NOTE,
    parseOptionalInt,
    promptResult,
    WRAP_UP_SECTION
} from './shared.js';

function buildInstructions(changeRequest: string, snapshotSection: string, isNewCampaign: boolean): string {
    const understandSection = isNewCampaign
        ? `## I. This is a NEW web rollout — gather requirements first

No campaignId was given, so there is nothing existing to inspect — but there is still a
lot to confirm before creating anything. ${NO_DELETE_CAMPAIGN_NOTE} Gather every item below
and restate the full plan to the user for explicit confirmation before making that call.
Don't infer a missing field silently — ask, except where a default is stated below.

1. **Workspace.** Confirm which workspace (\`accountId\`/\`workspaceName\`) this belongs to.
   Getting this wrong means the campaign now exists in the wrong client's account with no
   way to remove it through this server.
2. **Type is \`feature-rollout\`** — that's what this workflow builds, and it's why there
   is no control and no goal below; a rollout ships a change, it doesn't run an experiment.
3. **Editor URL (\`primaryUrl\`).** The exact page opened in VWO's visual editor to build
   the change against.
4. **Page targeting (\`urls\` / \`excludedUrls\`).** Does the rollout apply only to that one
   page, or match a broader pattern? Confirm explicitly — this is not a field with a safe
   silent default.
5. **Goals: there isn't one, but VWO's API requires the key anyway.** Try \`goals: []\` —
   VWO's documented schema shows no minimum length for this array, though that's not a
   guarantee the server accepts it. If \`vwo_new_campaign\` rejects an empty array, fall
   back to a single minimal placeholder goal (e.g. a "visitPage" goal on the primary URL)
   and tell the user plainly that it exists only to satisfy the API, not because this
   rollout has a real success metric.
6. **Audience.** Default to **All Visitors, with no segment filtering**, unless the user
   describes specific targeting. State this default explicitly in the plan so the user can
   override it — don't ask about audience if they haven't brought it up themselves.
7. **Rollout percentage.** Does this ship to 100% of eligible visitors immediately, or is
   it a staged/ramped rollout at some smaller percentage first? Default to 100% unless the
   user indicates staging — but state that assumption explicitly, since it's the one
   rollout-specific decision that materially changes exposure.
8. **One variation, no control.** State this explicitly in the plan. After creating the
   campaign, check what VWO actually created (\`vwo_get_campaign\` /
   \`vwo_list_campaign_variations\`) — if VWO auto-created an extra default variation you
   don't want, \`vwo_delete_campaign_variation\` can remove it (unlike a whole campaign, a
   single variation CAN be deleted) — but confirm with the user before deleting anything.
9. **What the variation specifically does.** A precise, concrete description — not "make
   it better." If the intended change is vague, ask before writing any \`editorData\`.

Once everything above is confirmed or defaulted (6 and 7 only), restate the full plan —
editor URL, targeting, audience, rollout percentage, and what the change does — and get
explicit confirmation before calling \`vwo_new_campaign\`.`
        : buildEditorDataUnderstandSection('I. Understand what exists before changing anything');

    return `# Web rollout edit workflow

Requested change: "${changeRequest}"

${snapshotSection}

${understandSection}

## II. Plan the change

Compare what you now understand (I) against the requested change. Decide exactly what in
\`editorData\` — or in the campaign's own properties (urls, rollout percentage) — needs to
change. Prefer the smallest change that satisfies the request.

State this plan in your response BEFORE calling any write tool. If the request is
ambiguous (e.g. "make the button pop more" with no specifics), ask the user to clarify
rather than guessing at specifics like an exact color.

## III. Apply the change

- Variation content/code → \`vwo_update_campaign_variation\`.
- Campaign-level properties (URLs, rollout percentage) → \`vwo_update_campaign\`.
- Brand-new rollout → \`vwo_new_campaign\` first, then \`vwo_new_campaign_variation\` for the
  one variation.

Make one focused change per call. Every one of these calls requires human approval in
hosts that enforce it (this server marks all writes that way); expect and wait for that,
it isn't a failure.

${buildVerificationSection('the SPECIFIC change from your plan (II), not just "did the page load"')}

${WRAP_UP_SECTION}

## Guardrails

- Never call \`vwo_update_campaign_status\` as part of this workflow unless the user
  explicitly asked to start/pause/stop the rollout.
- Don't add a control variation or a real analytical goal just because that's the default
  shape for an A/B test — a rollout intentionally has neither. If the API insists on a
  goal despite the schema showing no minimum length, add only the minimal placeholder
  described above and say why, rather than turning this into an experiment nobody asked
  for.
- Don't skip (I) and (II) even when the request seems obvious — reading \`editorData\`
  first is what catches cases where the request doesn't match what's actually there.`;
}

export function registerWebRolloutWorkflowPrompt(server: McpServer, ctx: ToolContext): void {
    server.registerPrompt(
        'vwo_web_rollout_workflow',
        {
            title: 'Create or edit a Web Rollout, verified',
            description:
                'The workflow for creating a new Web Rollout or editing an existing one. Mechanically ' +
                'the same as vwo_ab_test_workflow (same-page code changes, same live-preview ' +
                'verification) but with no control variation and no analytical goal — a rollout ships ' +
                'a change, it does not run an experiment. When campaignId is given, this prompt ' +
                'pre-fetches the campaign and its variations so the workflow starts from real data.',
            argsSchema: z.object({
                campaignId: z
                    .string()
                    .optional()
                    .describe('Existing campaign id to edit. Omit when creating a brand-new rollout.'),
                accountId: z.string().optional().describe('Numeric workspace id, if not using workspaceName.'),
                workspaceName: z.string().optional().describe('Workspace name to resolve, if not using accountId.'),
                changeRequest: z
                    .string()
                    .min(1)
                    .describe('Plain-English description of what should be created or changed.')
            })
        },
        async ({ campaignId: campaignIdRaw, accountId: accountIdRaw, workspaceName, changeRequest }) => {
            let campaignId: number | undefined;
            let accountId: number | undefined;
            try {
                campaignId = parseOptionalInt(campaignIdRaw);
                accountId = parseOptionalInt(accountIdRaw);
            } catch (error) {
                return promptResult(
                    `Could not parse the arguments to this prompt: ${redactError(error)}. ` +
                        'Resolve the workspace and campaign yourself (see vwo_general_guidance), then ' +
                        'follow the workflow below.\n\n' +
                        buildInstructions(changeRequest, '', true)
                );
            }

            if (campaignId === undefined) {
                return promptResult(buildInstructions(changeRequest, '', true));
            }

            const snapshotSection = await buildSnapshotSection(ctx, { accountId, workspaceName }, campaignId);

            return promptResult(
                buildInstructions(changeRequest, snapshotSection, false),
                `Web rollout edit workflow for campaign ${campaignId}`
            );
        }
    );
}
