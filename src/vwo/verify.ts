/**
 * Connectivity / credential check.
 *
 * Shared by the `vwo_verify_connection` tool and the `--verify` CLI flag, so a
 * human and an agent both confirm configuration the same way.
 *
 * Probes `GET /accounts`, which needs no account id — so verification works
 * before any account is chosen, and doubles as a check that the token really can
 * see the accounts the operator expects.
 */

import type { AccountRef, Config } from '../config.js';
import { tokenFingerprint } from '../redact.js';
import type { AccountDirectory, VwoAccount } from './accounts.js';
import { VwoApiError } from './errors.js';

export interface VerifyResult {
    ok: boolean;
    baseUrl: string;
    apiVersion: string;
    authHeader: string;
    tokenSource: string;
    /** Fingerprint only — never the token itself. */
    token: string;
    defaultAccountId: AccountRef | null;
    allowedAccountIds: readonly number[] | null;
    /** Present on success: accounts this token can reach. */
    accessibleAccounts?: VwoAccount[];
    /** Present on failure: actionable description of what went wrong. */
    error?: string;
    hint?: string;
}

export async function verifyConnection(accounts: AccountDirectory, config: Config): Promise<VerifyResult> {
    const base: VerifyResult = {
        ok: false,
        baseUrl: config.baseUrl,
        apiVersion: 'v2',
        authHeader: config.authHeader,
        tokenSource: config.tokenSource,
        token: tokenFingerprint(config.token),
        defaultAccountId: config.accountId ?? null,
        allowedAccountIds: config.allowedAccountIds.length > 0 ? config.allowedAccountIds : null
    };

    try {
        const visible = await accounts.list({ refresh: true });
        const result: VerifyResult = { ...base, ok: true, accessibleAccounts: visible };
        if (visible.length === 0) {
            result.hint =
                config.allowedAccountIds.length > 0
                    ? 'The token authenticated, but no visible account matched VWO_ALLOWED_ACCOUNT_IDS. Check those ids.'
                    : 'The token authenticated, but no accounts were returned. Check the token permission scope.';
        } else if (config.accountId === undefined) {
            result.hint =
                'No default account is set, so account-scoped tools require an explicit accountId. ' +
                'That is the safe default for a multi-account token; set VWO_ACCOUNT_ID to pin one.';
        }
        return result;
    } catch (error) {
        if (error instanceof VwoApiError) {
            const result: VerifyResult = { ...base, error: error.agentMessage };
            if (error.status === 401 || error.status === 403) {
                result.hint =
                    'Generate or re-scope a token at https://app.vwo.com/#/developers/tokens. ' +
                    `The token is being sent in the "${config.authHeader}" header; override with VWO_AUTH_HEADER if needed.`;
            } else if (error.status === 404) {
                result.hint =
                    `GET /accounts was not found under ${config.baseUrl}. If your account is on the ` +
                    'older host, set VWO_API_BASE_URL=https://app.vwo.com/api/v2';
            }
            return result;
        }
        throw error;
    }
}
