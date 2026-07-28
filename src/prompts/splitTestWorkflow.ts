/**
 * The workflow for creating or editing a Split URL test.
 *
 * Deliberately simpler than vwo_ab_test_workflow: a Split URL test has no
 * per-variation code to read or write. Each variation is a distinct,
 * already-existing destination URL that VWO redirects a bucketed visitor to
 * — confirmed by the `type` enum on VWO's own `GET /campaigns` filter
 * (`"split"`, not "split-url"; the same request checked "multivariate" is
 * used instead of "mvt", and "feature-rollout" for what this server's
 * vwo_web_rollout_workflow prompt covers).
 *
 * One thing this prompt is explicit about NOT knowing: VWO's OpenAPI spec
 * does not document which field on a variation carries its destination URL —
 * the only documented variation shape (shared across campaign types) is the
 * same `editorData` used for DOM changes, which doesn't obviously fit "this
 * variation redirects to a different URL." Rather than guess a field name,
 * this prompt tells the model to inspect what VWO actually returns after
 * creating/updating, and to check VWO's own support docs if that isn't
 * enough — see the vwo_general_guidance prompt's note on technical questions.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { redactError } from '../redact.js';
import type { ToolContext } from '../tools/shared.js';
import {
    buildSnapshotSection,
    buildVerificationSection,
    NEW_CAMPAIGN_REVERSIBILITY_NOTE,
    POST_CREATE_VERIFY_SECTION,
    parseOptionalInt,
    promptResult,
    WRAP_UP_SECTION
} from './shared.js';

const UNDOCUMENTED_DESTINATION_FIELD_NOTE =
    'How VWO expects a variation\'s destination URL to be attached is not clearly documented — ' +
    'the only documented variation shape is the same `editorData` field used for same-page DOM ' +
    'changes on an A/B test, which does not obviously fit "redirect to a different URL." Don\'t ' +
    'guess a field name from memory. Inspect what VWO actually returns after you create or update ' +
    'a variation, and if it is still unclear, search VWO\'s own support/documentation for "split ' +
    'URL test" (see vwo_general_guidance) rather than assuming.';

function buildInstructions(changeRequest: string, snapshotSection: string, isNewCampaign: boolean): string {
    const understandSection = isNewCampaign
        ? `## I. This is a NEW split test — gather requirements first

No campaignId was given, so there is nothing existing to inspect — but there is a lot to
confirm before creating anything. ${NEW_CAMPAIGN_REVERSIBILITY_NOTE} Gather every item below and
restate the full plan to the user for explicit confirmation before making that call.
Don't infer a missing field silently — ask, except where a default is stated below.

1. **Workspace.** Confirm which workspace (\`accountId\`/\`workspaceName\`) this belongs to.
   Getting this wrong creates the campaign in the wrong client's account. That is
   recoverable, but only by asking the user to approve deleting it — so confirm up front
   rather than relying on cleanup.
2. **Type is \`split\`** — that's what this workflow builds. (Not "split-url"; VWO's own
   enum uses the bare word "split".)
3. **Primary/control URL (\`primaryUrl\`).** The original page visitors see by default.
4. **Each variation's destination URL.** A distinct, already-existing URL per variation —
   ask for each one explicitly; don't invent or guess a URL. ${UNDOCUMENTED_DESTINATION_FIELD_NOTE}
5. **Page targeting (\`urls\` / \`excludedUrls\`).** Does the test apply only when a visitor
   is on the primary URL, or match a broader pattern? Confirm explicitly — this is not a
   field with a safe silent default.
6. **Goals.** At least one — VWO requires it to create the campaign, and a split test is
   still a controlled experiment (unlike a web rollout). Ask what defines success if the
   user hasn't said.
7. **Audience.** Default to **All Visitors, with no segment filtering**, unless the user
   describes specific targeting. State this default explicitly in the plan so the user can
   override it — don't ask about audience if they haven't brought it up themselves.
8. **Traffic split.** Default to an even split across control and all variations unless
   told otherwise. State this assumption in the plan too.
9. **Number of variations.** Extract this from the request if it's already implied by the
   number of destination URLs given (item 4); otherwise ask. Every variation needs its own
   destination URL — there's no such thing as a split-test variation without one.

Once everything above is confirmed or defaulted (7 and 8 only), restate the full plan —
primary URL, each variation's destination, targeting, goals, audience, and traffic split —
and get explicit confirmation before calling \`vwo_new_campaign\`.`
        : `## I. Understand what exists before changing anything

Using the current state shown above (if it could be fetched — check the heading), for
EACH variation, determine which destination URL it currently points to. ${UNDOCUMENTED_DESTINATION_FIELD_NOTE}
State what you found — which variation points where — before touching anything, even if
the requested change seems small and obvious.`;

    return `# Split URL test edit workflow

Requested change: "${changeRequest}"

${snapshotSection}

${understandSection}

## II. Plan the change

Compare what you now understand (I) against the requested change. Decide exactly: which
variation's destination URL needs to change, or which campaign-level property (targeting,
goals, traffic split) does. Prefer the smallest change that satisfies the request.

State this plan in your response BEFORE calling any write tool. If the request is
ambiguous about which variation or destination is meant, ask rather than guessing.

## III. Apply the change

- A variation's destination URL → \`vwo_update_campaign_variation\` (see the note above —
  inspect the result to confirm the field you set is the one that actually took effect).
- Campaign-level properties (targeting, goals, primary URL) → \`vwo_update_campaign\`.
- Brand-new test → \`vwo_new_campaign\` first, then \`vwo_new_campaign_variation\` for each
  variation, one destination URL each.

Make one focused change per call. Every one of these calls requires human approval in
hosts that enforce it (this server marks all writes that way); expect and wait for that,
it isn't a failure.

${POST_CREATE_VERIFY_SECTION}

${buildVerificationSection(
    'the destination URL(s) from your plan (II) — confirm you landed on the correct page and ' +
        'that it loaded without error. There is no DOM change to diff for a split test.',
    "The preview control may not let you choose which specific variation to preview. If it doesn't, " +
        'VWO\'s traffic split may route a given visit to any variation — treat one preview attempt as ' +
        '"did I land on ONE of the expected destinations, correctly," not confirmation of every ' +
        'variation at once. You may need to reopen the preview more than once to see a different one.'
)}

${WRAP_UP_SECTION}

## Guardrails

- Never call \`vwo_update_campaign_status\` as part of this workflow unless the user
  explicitly asked to start/pause/stop the campaign.
- Don't skip (I) even when the request seems obvious — confirming which destination each
  variation currently points to is what catches "change variation 2's URL" being ambiguous
  when there are three variations and it's unclear which one the user means.
- ${UNDOCUMENTED_DESTINATION_FIELD_NOTE}`;
}

export function registerSplitTestWorkflowPrompt(server: McpServer, ctx: ToolContext): void {
    server.registerPrompt(
        'vwo_split_test_workflow',
        {
            title: 'Create or edit a Split URL test, verified',
            description:
                'The workflow for creating a new Split URL test or editing an existing one. Simpler ' +
                'than vwo_ab_test_workflow: a split test has no per-variation code, just a distinct ' +
                'destination URL per variation. When campaignId is given, this prompt pre-fetches the ' +
                'campaign and its variations so the workflow starts from real data.',
            argsSchema: z.object({
                campaignId: z
                    .string()
                    .optional()
                    .describe('Existing campaign id to edit. Omit when creating a brand-new split test.'),
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
                `Split URL test edit workflow for campaign ${campaignId}`
            );
        }
    );
}
