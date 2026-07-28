/**
 * Configuration loading.
 *
 * The API token is read from the process environment (or a file it points at)
 * exactly once, at startup, before any tool is registered. It is never accepted
 * as a tool argument — see README.md -> "Why the token is not a tool parameter".
 */

import { readFileSync } from 'node:fs';

import { log } from './logger.js';
import { registerSecret, tokenFingerprint } from './redact.js';

export interface Config {
    /** VWO API token. Registered as a secret, so it is scrubbed from all output. */
    readonly token: string;
    /** Where the token came from, for diagnostics. Never includes the token itself. */
    readonly tokenSource: string;
    readonly baseUrl: string;
    /** Header name carrying the token. See .env.example for why this is configurable. */
    readonly authHeader: string;
    /**
     * Optional default account. Accepts a numeric id or the literal `current`.
     * When unset, account-scoped tools require an explicit `accountId` argument
     * rather than guessing — a token that manages many client accounts must
     * never silently operate on the wrong one.
     */
    readonly accountId: AccountRef | undefined;
    /**
     * Optional allow-list of account ids this server may touch. Empty means
     * "no restriction". A guardrail for tokens with access to many accounts.
     */
    readonly allowedAccountIds: readonly number[];
    /** Minimum spacing between outbound requests. VWO allows 1 req/sec per token. */
    readonly minRequestIntervalMs: number;
    readonly requestTimeoutMs: number;
}

export const DEFAULTS = {
    /**
     * Per VWO's own docs example:
     *   curl --url 'https://app.wingify.com/api/v2/accounts/current/campaigns' \
     *        --header 'token: <token>'
     * VWO is rebranding to Wingify; `https://app.vwo.com/api/v2` is the older
     * host. Override with VWO_API_BASE_URL if your account still uses it.
     */
    baseUrl: 'https://app.wingify.com/api/v2',
    authHeader: 'token',
    minRequestIntervalMs: 1000,
    requestTimeoutMs: 30_000
} as const;

/**
 * VWO accepts the literal `current` in place of a numeric account id, resolving
 * it from the token. Useful for single-account tokens, but it is NOT used as an
 * implicit fallback — see `resolveAccount` in tools/shared.ts for why.
 */
export const CURRENT_ACCOUNT = 'current';

/** An account id as it appears in a URL path. */
export type AccountRef = number | typeof CURRENT_ACCOUNT;

/** Thrown when configuration is missing or invalid. Message is safe to print. */
export class ConfigError extends Error {
    override readonly name = 'ConfigError';
}

function readIntEnv(name: string, fallback: number, min: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
        throw new ConfigError(`${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}.`);
    }
    return parsed;
}

function loadToken(): { token: string; source: string } {
    const tokenFile = process.env['VWO_API_TOKEN_FILE']?.trim();

    // A file-backed secret takes precedence: it keeps the token out of the
    // process environment, which is readable by other processes on some systems.
    if (tokenFile) {
        let contents: string;
        try {
            contents = readFileSync(tokenFile, 'utf8');
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new ConfigError(`VWO_API_TOKEN_FILE is set to ${tokenFile} but it could not be read: ${reason}`);
        }
        const token = contents.trim();
        if (token === '') {
            throw new ConfigError(`VWO_API_TOKEN_FILE is set to ${tokenFile} but the file is empty.`);
        }
        return { token, source: `VWO_API_TOKEN_FILE (${tokenFile})` };
    }

    const token = process.env['VWO_API_TOKEN']?.trim();
    if (!token) {
        throw new ConfigError(
            'No VWO API token found. Set VWO_API_TOKEN, or VWO_API_TOKEN_FILE pointing at a file ' +
                'containing the token. Generate one at https://app.vwo.com/#/developers/tokens'
        );
    }
    return { token, source: 'VWO_API_TOKEN' };
}

/**
 * Loads and validates configuration. Throws {@link ConfigError} with an
 * actionable message if the server cannot run.
 */
export function loadConfig(): Config {
    const { token, source } = loadToken();

    // Register before anything else can log or throw with the token in scope.
    registerSecret(token);

    const accountIdRaw = process.env['VWO_ACCOUNT_ID']?.trim();
    let accountId: AccountRef | undefined;
    if (accountIdRaw !== undefined && accountIdRaw !== '') {
        if (accountIdRaw === CURRENT_ACCOUNT) {
            accountId = CURRENT_ACCOUNT;
        } else {
            const parsed = Number(accountIdRaw);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new ConfigError(
                    `VWO_ACCOUNT_ID must be a positive integer or "current"; got ${JSON.stringify(accountIdRaw)}.`
                );
            }
            accountId = parsed;
        }
    }

    const allowedRaw = process.env['VWO_ALLOWED_ACCOUNT_IDS']?.trim();
    const allowedAccountIds: number[] = [];
    if (allowedRaw) {
        for (const part of allowedRaw.split(',')) {
            const trimmed = part.trim();
            if (trimmed === '') {
                continue;
            }
            const parsed = Number(trimmed);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new ConfigError(
                    `VWO_ALLOWED_ACCOUNT_IDS must be a comma-separated list of positive integers; got ${JSON.stringify(trimmed)}.`
                );
            }
            allowedAccountIds.push(parsed);
        }
    }
    if (typeof accountId === 'number' && allowedAccountIds.length > 0 && !allowedAccountIds.includes(accountId)) {
        throw new ConfigError(
            `VWO_ACCOUNT_ID (${accountId}) is not in VWO_ALLOWED_ACCOUNT_IDS (${allowedAccountIds.join(', ')}).`
        );
    }

    const baseUrl = (process.env['VWO_API_BASE_URL']?.trim() || DEFAULTS.baseUrl).replace(/\/+$/, '');
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'https:') {
            throw new ConfigError(`VWO_API_BASE_URL must use https; got ${parsed.protocol.replace(':', '')}.`);
        }
    } catch (error) {
        if (error instanceof ConfigError) {
            throw error;
        }
        throw new ConfigError(`VWO_API_BASE_URL is not a valid URL: ${JSON.stringify(baseUrl)}`);
    }
    // v1 is retired: it answers HTTP 200 with an INCORRECT_API_VERSION body,
    // which would otherwise look like a successful response. Refuse it outright.
    if (!/\/v2$/.test(baseUrl)) {
        throw new ConfigError(
            `VWO_API_BASE_URL must point at API v2 (path ending in /v2); got ${baseUrl}. ` +
                `The default is ${DEFAULTS.baseUrl}.`
        );
    }

    const config: Config = {
        token,
        tokenSource: source,
        baseUrl,
        authHeader: process.env['VWO_AUTH_HEADER']?.trim() || DEFAULTS.authHeader,
        accountId,
        allowedAccountIds,
        minRequestIntervalMs: readIntEnv('VWO_MIN_REQUEST_INTERVAL_MS', DEFAULTS.minRequestIntervalMs, 0),
        requestTimeoutMs: readIntEnv('VWO_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 1000)
    };

    log.info('Configuration loaded.', {
        tokenSource: config.tokenSource,
        token: tokenFingerprint(config.token),
        baseUrl: config.baseUrl,
        authHeader: config.authHeader,
        accountId: config.accountId ?? '(not set — tools will require an explicit accountId)',
        allowedAccountIds: config.allowedAccountIds.length > 0 ? config.allowedAccountIds.join(',') : '(unrestricted)'
    });

    return config;
}
