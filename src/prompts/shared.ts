/**
 * Shared plumbing for prompt definitions.
 *
 * Prompts are a different primitive from tools: rather than performing an
 * action, a prompt returns text that steers how the model approaches a
 * situation. Nothing in MCP requires a host to surface prompts to the model —
 * see README.md -> "Prompts: what they are and their limits" before assuming
 * these are automatically in play.
 *
 * Wire format note: per the MCP spec, `prompts/get` arguments are always
 * `Record<string, string>` — there is no numeric or boolean argument type.
 * Every prompt argument here is declared as a string and parsed by hand.
 *
 * This module also holds the pieces shared by the three campaign-editing
 * workflow prompts (A/B test, split test, web rollout): fetching a campaign's
 * current state, and the verify/wrap-up sections whose content is identical
 * across workflows that differ only in what they create and how they check it.
 */

import type { GetPromptResult } from '@modelcontextprotocol/server';

import { redact, redactError } from '../redact.js';
import { resolveAccount, type ToolContext } from '../tools/shared.js';
import { isAgentFacingError } from '../vwo/errors.js';

/** Builds a single-message prompt result. Content is one object, not an array. */
export function promptResult(text: string, description?: string): GetPromptResult {
    return {
        description,
        messages: [
            {
                role: 'user',
                content: { type: 'text', text: redact(text) }
            }
        ]
    };
}

/** Parses an optional string prompt argument as a positive integer, or undefined if blank/absent. */
export function parseOptionalInt(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') {
        return undefined;
    }
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive integer, got ${JSON.stringify(value)}.`);
    }
    return parsed;
}

/**
 * Stated at the top of every "create a new campaign" gather-requirements
 * section. This server has no `delete_campaign` tool (only
 * `vwo_delete_draft_campaigns`, a different resource) — once `vwo_new_campaign`
 * succeeds, none of these workflows can undo it, which is why they all insist
 * on confirming everything before that call rather than inferring silently.
 */
export const NO_DELETE_CAMPAIGN_NOTE =
    '**This server has no `delete_campaign` tool.** Once `vwo_new_campaign` succeeds, ' +
    'this workflow has no way to undo it.';

// ---------------------------------------------------------------------------
// Campaign snapshot fetching — shared by every workflow that edits an
// existing campaign, so the model starts from real data instead of spending
// a turn discovering it.
// ---------------------------------------------------------------------------

/** Bounds worst-case latency: each fetch is rate-limited to ~1/sec by the client. */
const MAX_VARIATIONS_TO_FETCH = 6;

export interface CampaignSnapshot {
    campaign: Record<string, unknown>;
    variations: Array<Record<string, unknown> | { id: unknown; error: string }>;
    truncated: boolean;
}

async function fetchCampaignSnapshot(
    ctx: ToolContext,
    account: number | string,
    campaignId: number
): Promise<CampaignSnapshot> {
    const campaignResponse = await ctx.client.get<{ _data?: Record<string, unknown> }>(
        `/accounts/${account}/campaigns/${campaignId}`
    );
    const campaign = campaignResponse?._data ?? {};

    const listResponse = await ctx.client.get<{ _data?: Array<{ id?: unknown }> }>(
        `/accounts/${account}/campaigns/${campaignId}/variations`
    );
    const variationRefs = Array.isArray(listResponse?._data) ? listResponse._data : [];
    const truncated = variationRefs.length > MAX_VARIATIONS_TO_FETCH;
    const idsToFetch = variationRefs.slice(0, MAX_VARIATIONS_TO_FETCH);

    const variations: CampaignSnapshot['variations'] = [];
    for (const ref of idsToFetch) {
        const id = ref.id;
        try {
            const detail = await ctx.client.get<{ _data?: Record<string, unknown> }>(
                `/accounts/${account}/campaigns/${campaignId}/variations/${id}`
            );
            variations.push(detail?._data ?? { id, error: 'empty response' });
        } catch (error) {
            variations.push({ id, error: isAgentFacingError(error) ? error.agentMessage : redactError(error) });
        }
    }

    return { campaign, variations, truncated };
}

/**
 * Resolves the account and fetches the campaign snapshot, formatted as the
 * markdown section every workflow embeds. Never throws: any failure (bad
 * token, wrong id, ambiguous workspace) degrades to text instructing the
 * model to fetch that information itself — a prompt that errors out is worse
 * than one that admits it couldn't pre-fetch.
 */
export async function buildSnapshotSection(
    ctx: ToolContext,
    args: { accountId: number | undefined; workspaceName: string | undefined },
    campaignId: number
): Promise<string> {
    try {
        const account = await resolveAccount(ctx, args);
        const snapshot = await fetchCampaignSnapshot(ctx, account, campaignId);
        const truncationNote = snapshot.truncated
            ? `\n\n(Only the first ${MAX_VARIATIONS_TO_FETCH} variations were pre-fetched; call ` +
              '`vwo_list_campaign_variations` for the rest.)'
            : '';
        return (
            '## Current state (fetched just now — verify anything critical yourself, since it ' +
            'may be superseded by the time you act)\n\n' +
            '```json\n' +
            JSON.stringify({ account, campaignId, ...snapshot }, null, 2) +
            '\n```' +
            truncationNote
        );
    } catch (error) {
        const message = isAgentFacingError(error) ? error.agentMessage : redactError(error);
        return (
            `## Current state: could not be pre-fetched\n\n${message}\n\nResolve this yourself ` +
            '(call `vwo_get_campaign` and `vwo_get_campaign_variation`) before proceeding — do not ' +
            'proceed to planning a change against a campaign you have not actually looked at.'
        );
    }
}

/**
 * The "read the code before touching it" section for workflows where a
 * variation's change is DOM/JS/CSS edits (`editorData`) — A/B tests and web
 * rollouts. Split tests use their own version, since there is no code to
 * read: each variation there is simply a different destination URL.
 */
export function buildEditorDataUnderstandSection(heading: string): string {
    return `## ${heading}

Using the current state shown above (if it could be fetched — check the heading), for
EACH variation:

- Read its \`editorData\` (and any other fields present — VWO does not document this
  field's exact shape, so read what is actually there rather than assuming field names
  from memory or from another campaign you've seen).
- Work out, in your own words, what that variation currently changes about the page.
  State this explicitly in your response before touching anything, even if the requested
  change seems small and obvious.
- If \`editorData\` looks empty or the snapshot looks incomplete/stale, don't assume that
  means "no changes" — call \`vwo_get_campaign_variation\` directly to confirm before
  proceeding.`;
}

/**
 * The verify-in-a-browser section (IV) plus the iterate section (V).
 *
 * Two things confirmed against VWO's live API/product before writing this,
 * not assumed: `vwo_get_campaign_share_link` returns a link into VWO's own
 * dashboard summary/report page, not a rendered preview — VWO's API has no
 * "preview URL" endpoint. That summary page separately hosts a UI control
 * (URL field + button) that opens a live rendering in a new tab; that's a
 * product feature, not a documented contract, so the model is told to locate
 * it visually rather than assume fixed coordinates.
 *
 * @param compareTarget What "compare what you see" means for this workflow —
 *   phrased differently for a rendered DOM change vs. a redirect destination.
 * @param extraPreviewNote Optional workflow-specific caveat inserted into the
 *   preview steps (e.g. bucketing randomness for split tests).
 */
export function buildVerificationSection(compareTarget: string, extraPreviewNote?: string): string {
    const note = extraPreviewNote ? `\n   ${extraPreviewNote}` : '';
    return `## IV. Get a live view to verify

1. Call \`vwo_get_campaign_share_link\`. This returns a link into VWO's own dashboard
   summary/report page for the campaign — it is NOT a rendered preview by itself; VWO's
   API has no separate "preview URL" endpoint.
2. **Check whether you actually have a way to do this, before relying on it.** Look at
   your own available tools for ANY browser automation capability — Chrome DevTools MCP,
   or another browser tool. Don't gate this on the specific name "Chrome DevTools MCP";
   any tool that can open a URL, list open tabs, and take a screenshot qualifies.
3. **If you have one**, use it — prefer an embedded/in-app browser surface over spawning
   a separate OS window, if the tool offers that choice:
   a. Open the share link.
   b. That summary page has a preview control: a field to enter a URL and a button that
      opens a live rendering of the campaign for that URL in a NEW tab. This is a product
      UI feature, not a documented API contract, so its exact layout can vary — take a
      screenshot first to locate it visually rather than assuming fixed coordinates. Enter
      the campaign's \`primaryUrl\` and activate the preview button.${note}
   c. Enumerate open tabs/pages with your browser tool to find the tab the preview button
      just opened, and switch to it.
   d. Screenshot that tab (and read its text/structure too, if your tool supports that —
      a screenshot alone can be ambiguous about exact wording or color). Compare what you
      see against ${compareTarget}.
4. **If you have no browser automation tool at all, say so to the user explicitly and
   immediately** — before or right after making the change, not only after silently
   trying and failing. Don't quietly downgrade to a weaker check and imply the change is
   verified when it isn't. Then, in order:
   a. Ask the user to open the share link themselves, use the preview control, and tell
      you (or screenshot) what they see. Treat their report as the verification.
   b. If that isn't practical either, fall back to re-fetching the variation
      (\`vwo_get_campaign_variation\`) to confirm the stored data reflects the intended
      edit. This confirms it was stored correctly — it is **not** the same as confirming
      it renders/redirects correctly. Say exactly that when reporting back: the change is
      applied but visually **unverified**, not verified. Don't round this up to "done."

## V. Iterate

- If the preview (or the user's report of it) doesn't show the intended result, diagnose
  before retrying blindly — check the response from your update call for clues. Then
  return to (III) with a corrected edit.
- After any further edit: with your own browser tool, reload the SAME preview tab you
  already have open rather than reopening the share link from scratch. If the user is
  checking on your behalf, ask them to refresh their own tab rather than repeating the
  whole open-and-click sequence.
- If three consecutive verification attempts still don't show the intended result, stop.
  Report exactly what you tried and observed each time, and ask the user how to proceed
  rather than continuing to guess.`;
}

/** The wrap-up section (VI) — identical across every campaign-editing workflow. */
export const WRAP_UP_SECTION = `## VI. Wrap up

Summarize for the user: what changed, on which variation(s), the share link for their own
reference, and — explicitly — how it was verified: visually by you, visually by the user's
own report, or only via stored data (say "unverified" plainly in that last case, don't
imply more confidence than you have). Invite feedback. If the user asks for more changes,
treat that as a new instance of the plan step — re-plan, re-apply, and re-verify, reusing
the still-open preview tab where possible rather than starting the whole flow over.`;
