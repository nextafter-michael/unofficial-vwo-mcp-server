/**
 * Shared plumbing for tool definitions.
 *
 * Every tool goes through {@link toolHandler} so that no VWO or runtime error
 * ever escapes as an unhandled rejection, and so failures come back to the
 * model as readable, redacted, actionable text.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AccountRef, Config } from '../config.js';
import { log } from '../logger.js';
import { redactError } from '../redact.js';
import type { AccountDirectory } from '../vwo/accounts.js';
import type { VwoClient } from '../vwo/client.js';
import { isAgentFacingError, VwoToolError } from '../vwo/errors.js';

/** Everything a tool implementation is allowed to reach. */
export interface ToolContext {
    readonly client: VwoClient;
    readonly config: Config;
    readonly accounts: AccountDirectory;
}

/** A successful result carrying both human-readable text and structured data. */
export function jsonResult(data: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data as Record<string, unknown>
    };
}

export function textResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Wraps a tool implementation with uniform error handling.
 *
 * VWO failures become `isError` results with guidance the agent can act on,
 * rather than exceptions that surface as opaque internal errors.
 */
export function toolHandler<Args>(
    name: string,
    implementation: (args: Args) => Promise<CallToolResult>
): (args: Args) => Promise<CallToolResult> {
    return async (args: Args) => {
        try {
            return await implementation(args);
        } catch (error) {
            if (isAgentFacingError(error)) {
                log.warn(`Tool ${name} failed`, error.message);
                return errorResult(error.agentMessage);
            }
            log.error(`Tool ${name} threw an unexpected error`, redactError(error));
            return errorResult(`Tool ${name} failed unexpectedly: ${redactError(error)}`);
        }
    };
}

/**
 * The account-targeting arguments every account-scoped tool should accept.
 *
 * Spread into a tool's `z.object({...})`. Descriptions are written for the
 * model: they are the main mechanism steering it to resolve names to ids rather
 * than inventing one.
 */
export const accountArgs = {
    accountId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            'Numeric VWO workspace (account) id to operate on. Required unless the server ' +
                'has a default workspace configured. If the user referred to a workspace by name, ' +
                'either pass workspaceName instead or call vwo_list_workspaces to look up the id — ' +
                'never guess an id.'
        ),
    workspaceName: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Workspace name to resolve to an id, as an alternative to accountId. Must match ' +
                'exactly one visible workspace, otherwise an error lists the candidates.'
        )
} as const;

/** Identifies a campaign within a workspace. */
export const campaignIdArg = {
    campaignId: z
        .number()
        .int()
        .positive()
        .describe('VWO campaign id. Call vwo_list_campaigns first if you do not have it.')
} as const;

/** Standard VWO limit/offset paging. */
export const paginationArgs = {
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum number of items to return.'),
    offset: z.number().int().min(0).default(0).describe('Number of items to skip, for paging.')
} as const;

/**
 * A free-form request body.
 *
 * Used for the many VWO write endpoints whose request schema the API reference
 * does not document. Inventing a strict schema for those would reject valid
 * payloads, so the body is passed through and VWO validates it — the tool
 * description carries the doc link the agent needs to construct it.
 */
export function bodyArg(docUrl: string, guidance: string) {
    return {
        body: z
            .record(z.string(), z.unknown())
            .describe(
                `${guidance} VWO does not publish a schema for this request body; see ${docUrl} ` +
                    'for the accepted fields. The object is sent to VWO as-is.'
            )
    } as const;
}

/** VWO wraps payloads in `_data`. `_metadata` is declared because VWO's docs imply it, but see {@link extractCollection}. */
export interface VwoEnvelope {
    _data?: unknown;
    _metadata?: { total?: number };
}

/** Unwraps VWO's `_data` envelope, tolerating endpoints that omit it. */
export function unwrapData(response: unknown): unknown {
    if (response !== null && typeof response === 'object' && '_data' in response) {
        return (response as VwoEnvelope)._data;
    }
    return response;
}

/** VWO's paged-collection wrapper — used by SOME list endpoints, not all. */
interface WrappedCollection {
    partialCollection?: unknown;
    totalCount?: unknown;
    offset?: unknown;
}

export interface ExtractedCollection {
    items: unknown[];
    /** Server-reported total across all pages, when the endpoint provides one. */
    total: number | undefined;
    /** Set only when `_data` had a shape this code does not recognize. */
    unrecognizedShape: string | undefined;
}

/**
 * Pulls the item array out of a VWO list response.
 *
 * VWO is not consistent about collection shape, verified against the live API:
 *  - `GET /campaigns` (no `status`) and `GET /insights-metrics` return
 *    `_data: { partialCollection: [...], totalCount, offset }`
 *  - `GET /campaigns?status=…`, `/drafts`, `/feeds`, `/goals`, `/variations`
 *    and `/accounts` return `_data` as a flat array
 *  - `/labels` and `/changesets` omit `_data` entirely when empty
 *  - `_metadata` is never actually present on any of them; the real total
 *    lives at `_data.totalCount` on the wrapped shape only
 *
 * An earlier version of this only handled the flat-array case and silently
 * returned zero items for the wrapped one — which made a workspace holding 142
 * campaigns report `count: 0`. Silence was the actual damage there, so an
 * unrecognized shape is now reported in the result rather than swallowed.
 */
export function extractCollection(response: VwoEnvelope | undefined): ExtractedCollection {
    const data = response?._data;

    if (Array.isArray(data)) {
        const metadataTotal = response?._metadata?.total;
        return {
            items: data,
            total: typeof metadataTotal === 'number' ? metadataTotal : undefined,
            unrecognizedShape: undefined
        };
    }

    // Legitimately empty: several endpoints omit `_data` rather than sending [].
    if (data === undefined || data === null) {
        return { items: [], total: undefined, unrecognizedShape: undefined };
    }

    if (typeof data === 'object') {
        const wrapped = data as WrappedCollection;
        // Keyed on the KEY's presence, not on its value being an array: when a
        // wrapped endpoint has nothing to return, VWO sends `partialCollection`
        // as a non-array (observed on `/insights-metrics` with totalCount 0).
        // Requiring an array there produced a false "unrecognized shape"
        // warning for what was really just an empty collection.
        if ('partialCollection' in wrapped) {
            return {
                items: Array.isArray(wrapped.partialCollection) ? wrapped.partialCollection : [],
                total: typeof wrapped.totalCount === 'number' ? wrapped.totalCount : undefined,
                unrecognizedShape: undefined
            };
        }
        return {
            items: [],
            total: undefined,
            unrecognizedShape: `object with keys: ${Object.keys(wrapped).join(', ') || '(none)'}`
        };
    }

    return { items: [], total: undefined, unrecognizedShape: typeof data };
}

/** Result shape for a paged collection, including a ready-to-use next offset. */
export function listResult(
    response: VwoEnvelope | undefined,
    context: { limit: number; offset: number } & Record<string, unknown>
): CallToolResult {
    const { items, total, unrecognizedShape } = extractCollection(response);
    const { limit, offset, ...rest } = context;

    // Prefer the server-reported total when there is one: `items.length ===
    // limit` alone can't tell a full last page from a page with more behind it.
    const consumed = offset + items.length;
    const nextOffset =
        total !== undefined ? (consumed < total ? consumed : null) : items.length === limit ? consumed : null;

    return jsonResult({
        ...rest,
        count: items.length,
        total,
        nextOffset,
        ...(unrecognizedShape === undefined
            ? {}
            : {
                  warning:
                      `VWO returned a _data shape this server does not recognize (${unrecognizedShape}), so no ` +
                      'items could be extracted. This is a bug in the MCP server, not necessarily an empty result — ' +
                      'report it rather than concluding there is no data.'
              }),
        items
    });
}

export interface AccountArgs {
    accountId?: number | undefined;
    workspaceName?: string | undefined;
}

/**
 * Spread into the config of a tool that changes live VWO state.
 *
 * Claude Code honours this by always showing a permission prompt for the tool —
 * even in `auto`/`bypassPermissions` modes, and even if an `allow` rule matches
 * it. Use it for anything a person should consciously agree to (starting or
 * stopping a campaign, deleting a goal), so no config mistake can turn a
 * destructive VWO write into a silent auto-approval.
 */
export const REQUIRES_HUMAN_APPROVAL = {
    _meta: { 'anthropic/requiresUserInteraction': true }
} as const;

function assertAllowed(config: Config, accountId: number): void {
    if (config.allowedAccountIds.length > 0 && !config.allowedAccountIds.includes(accountId)) {
        throw new VwoToolError(
            `Account ${accountId} is not in this server's allowed account list ` +
                `(${config.allowedAccountIds.join(', ')}). This is a deliberate restriction ` +
                'configured by the operator; tell the user rather than trying other ids.'
        );
    }
}

/**
 * Decides which account a tool acts on, in priority order:
 *   1. explicit `accountId`
 *   2. `accountName`, resolved via the account directory
 *   3. the server's configured default (`VWO_ACCOUNT_ID`)
 *
 * With none of those it throws a *guidance* error instead of falling back to
 * `accounts/current`. Silently defaulting is the dangerous option here: a token
 * that manages many client accounts would happily run the call against whichever
 * account VWO considers "current", which is rarely the one the user meant.
 */
export async function resolveAccount(ctx: ToolContext, args: AccountArgs): Promise<AccountRef> {
    if (args.accountId !== undefined) {
        assertAllowed(ctx.config, args.accountId);
        return args.accountId;
    }

    if (args.workspaceName !== undefined && args.workspaceName.trim() !== '') {
        const account = await ctx.accounts.resolveByName(args.workspaceName);
        assertAllowed(ctx.config, account.id);
        log.debug(`Resolved workspace name ${JSON.stringify(args.workspaceName)} to id ${account.id}.`);
        return account.id;
    }

    if (ctx.config.accountId !== undefined) {
        return ctx.config.accountId;
    }

    throw new VwoToolError(
        'No VWO workspace specified and this server has no default workspace configured. ' +
            'Call vwo_list_workspaces to see the workspaces this token can access, then retry with ' +
            'the accountId the user intends. If it is ambiguous, ask the user which one to use.'
    );
}
