/**
 * Account (a.k.a. "workspace") discovery.
 *
 * VWO's UI calls these workspaces; the v2 API exposes them at `GET /accounts`.
 * (`/workspaces` does not exist — it 404s.) A token that manages several client
 * accounts sees them all here, which is how the agent turns an account *name*
 * from the user into the numeric id the other endpoints need.
 *
 * Results are cached briefly because VWO allows only 1 request/second per
 * token, and name resolution would otherwise spend that budget on every call.
 */

import type { Config } from '../config.js';
import { log } from '../logger.js';
import type { VwoClient } from './client.js';
import { VwoToolError } from './errors.js';

const CACHE_TTL_MS = 60_000;

export interface VwoAccount {
    id: number;
    name: string;
}

interface AccountListResponse {
    _data?: unknown[];
}

/** Pulls id/name out of an account record without assuming the full shape. */
function normalizeAccount(raw: unknown): VwoAccount | undefined {
    if (raw === null || typeof raw !== 'object') {
        return undefined;
    }
    const record = raw as Record<string, unknown>;
    const id = Number(record['id'] ?? record['accountId'] ?? record['sId']);
    if (!Number.isInteger(id) || id <= 0) {
        return undefined;
    }
    const nameValue = record['name'] ?? record['accountName'] ?? record['title'];
    return { id, name: typeof nameValue === 'string' ? nameValue : `Account ${id}` };
}

export class AccountDirectory {
    #cache: { accounts: VwoAccount[]; fetchedAt: number } | undefined;

    constructor(
        private readonly client: VwoClient,
        private readonly config: Config
    ) {}

    /** All accounts this token can see, filtered by the configured allow-list. */
    async list(options: { refresh?: boolean } = {}): Promise<VwoAccount[]> {
        const cached = this.#cache;
        if (!options.refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.accounts;
        }

        const response = await this.client.get<AccountListResponse>('/accounts', { limit: 100, offset: 0 });
        const raw = Array.isArray(response?._data) ? response._data : [];

        let accounts = raw
            .map(normalizeAccount)
            .filter((account): account is VwoAccount => account !== undefined);

        const { allowedAccountIds } = this.config;
        if (allowedAccountIds.length > 0) {
            const before = accounts.length;
            accounts = accounts.filter(account => allowedAccountIds.includes(account.id));
            log.debug(`Account allow-list filtered ${before} accounts down to ${accounts.length}.`);
        }

        this.#cache = { accounts, fetchedAt: Date.now() };
        return accounts;
    }

    /**
     * Resolves a user-supplied account name to a single account.
     *
     * Deliberately strict: an ambiguous or unknown name raises an error listing
     * the candidates rather than picking one, so the agent surfaces the choice
     * instead of guessing which client's data to touch.
     */
    async resolveByName(name: string): Promise<VwoAccount> {
        const accounts = await this.list();
        const needle = name.trim().toLowerCase();

        const exact = accounts.filter(account => account.name.toLowerCase() === needle);
        if (exact.length === 1) {
            return exact[0]!;
        }

        const partial = accounts.filter(account => account.name.toLowerCase().includes(needle));
        if (partial.length === 1) {
            return partial[0]!;
        }

        const candidates = (exact.length > 1 ? exact : partial)
            .map(account => `${account.name} (id ${account.id})`)
            .join(', ');

        if (candidates === '') {
            throw new VwoToolError(
                `No VWO account matches "${name}". Available: ` +
                    `${accounts.map(a => `${a.name} (id ${a.id})`).join(', ') || '(none visible to this token)'}. ` +
                    'Ask the user which account they mean; do not guess.'
            );
        }

        throw new VwoToolError(
            `"${name}" matches more than one VWO account: ${candidates}. ` +
                'Ask the user which one they mean and pass its numeric accountId.'
        );
    }
}
