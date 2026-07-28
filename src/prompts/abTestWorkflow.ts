/**
 * The precise inspect -> plan -> apply -> verify -> iterate workflow for
 * creating or editing an A/B test.
 *
 * See prompts/shared.ts for the pieces this composes: the campaign snapshot
 * fetch, the editorData-understand section, the verify/iterate section, and
 * the wrap-up. This file holds what's specific to an A/B test: the full
 * new-campaign requirements checklist (type, targeting, goals, control) and
 * the plan/apply sections.
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
        ? `## I. This is a NEW test — gather requirements first

No campaignId was given, so there is nothing existing to inspect — but there is a lot to
confirm before creating anything. ${NO_DELETE_CAMPAIGN_NOTE} Gather every item below and
restate the full plan to the user for explicit confirmation before making that call.
Don't infer a missing field silently — ask, except where a default is stated below.

1. **Workspace.** Confirm which workspace (\`accountId\`/\`workspaceName\`) this belongs to.
   Getting this wrong means the campaign now exists in the wrong client's account with no
   way to remove it through this server.
2. **Campaign type.** VWO's type values are lowercase and hyphenated — "ab" for a
   classic A/B test, "split" for Split URL (redirects to a different URL per variation
   instead of modifying the page in place), "multivariate" for MVT. These behave
   differently enough that guessing produces the wrong kind of test, not just a wrong
   detail. Ask if not stated; default to "ab" only if the user's description clearly
   implies a same-page content change with no mention of separate URLs per variation.
3. **Editor URL (\`primaryUrl\`).** The exact page opened in VWO's visual editor to build
   variations against.
4. **Page targeting (\`urls\` / \`excludedUrls\`).** Does the test run only on that one page,
   or match a broader pattern (e.g. all URLs under a path)? If the user names only one
   page and gives no indication of broader scope, confirm explicitly that it's scoped to
   that page alone — this is not a field with a safe silent default.
5. **Goals.** At least one — VWO requires it to create the campaign. Ask what defines
   success if the user hasn't said.
6. **Audience.** Default to **All Visitors, with no segment filtering**, unless the user
   describes specific targeting (device, geography, a custom segment, etc.). State this
   default explicitly in the plan you present so the user can override it — don't ask
   about audience if they haven't brought it up themselves.
7. **Traffic split.** Default to an even split across control and all variations unless
   told otherwise. State this assumption in the plan too.
8. **Number of variations**, beyond the control. Extract this from the request if it's
   already implied (e.g. "test three headlines" means 3); otherwise ask.
9. **What each variation specifically does.** A precise, concrete description per
   variation — not "make it better." If any single variation's intended change is vague,
   ask about that one specifically before writing any \`editorData\` for it. This is the
   same rigor as section I for an existing test; it just starts from a description
   instead of existing code.

Once everything above is confirmed or defaulted (6 and 7 only), restate the full plan —
type, editor URL, targeting, goals, audience, traffic split, and each variation's change —
and get explicit confirmation before calling \`vwo_new_campaign\`.`
        : buildEditorDataUnderstandSection('I. Understand what exists before changing anything');

    return `# A/B test edit workflow

Requested change: "${changeRequest}"

${snapshotSection}

${understandSection}

## II. Plan the change

Compare what you now understand (I) against the requested change. Decide exactly:
which variation(s) need to change, and precisely what in \`editorData\` — or in the
campaign's own properties (urls, goals, name) — needs to change to accomplish the
request. Prefer the smallest change that satisfies it.

State this plan in your response BEFORE calling any write tool. If the request is
ambiguous (e.g. "make the button pop more" with no specifics), ask the user to clarify
rather than guessing at specifics like an exact color.

## III. Apply the change

- Variation content/code → \`vwo_update_campaign_variation\` (pass only the fields that
  change).
- Campaign-level properties (URLs, goals, name) → \`vwo_update_campaign\`.
- Brand-new test → \`vwo_new_campaign\` first, then \`vwo_new_campaign_variation\` for each
  variation beyond the default control.

Make one focused change per call — don't bundle unrelated edits together. Every one of
these calls requires human approval in hosts that enforce it (this server marks all
writes that way); expect and wait for that, it isn't a failure.

${buildVerificationSection('the SPECIFIC change from your plan (II), not just "did the page load"')}

${WRAP_UP_SECTION}

## Guardrails

- Never call \`vwo_update_campaign_status\` as part of this workflow unless the user
  explicitly asked to start/pause/stop the campaign — that's a separate action from
  content edits and shouldn't happen as a side effect of one.
- Don't skip (I) and (II) even when the request seems obvious — reading \`editorData\`
  first is what catches cases where the request doesn't match what's actually there
  (e.g. "revert the headline" when there are three variations and it's unclear which one
  changed it).`;
}

export function registerAbTestWorkflowPrompt(server: McpServer, ctx: ToolContext): void {
    server.registerPrompt(
        'vwo_ab_test_workflow',
        {
            title: 'Create or edit an A/B test, verified',
            description:
                'The precise workflow for creating a new A/B test or editing an existing one: ' +
                'inspect the current variation code, plan the specific change, apply it, then visually ' +
                'verify it rendered correctly via VWO\'s live preview before considering it done. When ' +
                'campaignId is given, this prompt pre-fetches the campaign and its variations (including ' +
                'their code) so the workflow starts from real data. Use this instead of editing a live ' +
                'test ad hoc. For a Split URL test or a Web Rollout, use vwo_split_test_workflow or ' +
                'vwo_web_rollout_workflow instead — they follow the same shape but account for how those ' +
                'differ from a same-page content test.',
            argsSchema: z.object({
                campaignId: z
                    .string()
                    .optional()
                    .describe('Existing campaign id to edit. Omit when creating a brand-new test.'),
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
                `A/B test edit workflow for campaign ${campaignId}`
            );
        }
    );
}
