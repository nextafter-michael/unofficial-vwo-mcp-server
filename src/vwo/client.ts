/**
 * Thin HTTP client for the VWO REST API.
 *
 * Responsibilities kept here so tool code never touches auth or transport:
 *  - attaches the auth header (the only place the token is read)
 *  - paces requests to VWO's documented 1 request/second per-token limit
 *  - retries transient failures with backoff
 *  - converts every failure into a {@link VwoApiError} whose message is redacted
 */

import type { Config } from '../config.js';
import { log } from '../logger.js';
import { redact } from '../redact.js';
import { VwoApiError } from './errors.js';

const MAX_ATTEMPTS = 3;
/** Cap on how much of an error body we keep, to avoid flooding model context. */
const MAX_ERROR_BODY_CHARS = 600;

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
    query?: Record<string, QueryValue>;
    body?: unknown;
    /** Overrides the default retry behaviour for non-idempotent calls. */
    retry?: boolean;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * VWO's error envelope: `{"_errors":[{"code":401,"message":"Invalid API token"}]}`.
 * Returns a joined message, or undefined if the payload isn't an error envelope.
 */
function extractErrorEnvelope(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== 'object') {
        return undefined;
    }

    // Retired API versions answer HTTP 200 with this shape, so a wrong base URL
    // would otherwise be indistinguishable from success.
    if ('API_ERROR' in payload) {
        const record = payload as { API_ERROR?: unknown; API_ERROR_DESCRIPTION?: unknown };
        return `${String(record.API_ERROR)}: ${String(record.API_ERROR_DESCRIPTION ?? '')}`.trim();
    }

    if ('_errors' in payload) {
        const errors = (payload as { _errors?: unknown })._errors;
        if (Array.isArray(errors) && errors.length > 0) {
            return errors
                .map(entry => {
                    if (entry !== null && typeof entry === 'object') {
                        const record = entry as { code?: unknown; message?: unknown };
                        return `${record.code ?? '?'}: ${record.message ?? JSON.stringify(entry)}`;
                    }
                    return String(entry);
                })
                .join('; ');
        }
    }

    return undefined;
}

export class VwoClient {
    /** Serializes the rate-limit gate; requests themselves may overlap. */
    #gate: Promise<unknown> = Promise.resolve();
    #lastRequestStartedAt = 0;

    constructor(private readonly config: Config) {}

    /**
     * Waits until this request is allowed to start, preserving call order.
     * VWO rate-limits per token, so the whole process shares one gate.
     */
    async #waitForSlot(): Promise<void> {
        const interval = this.config.minRequestIntervalMs;
        if (interval <= 0) {
            return;
        }
        const ticket = this.#gate.then(async () => {
            const waitMs = this.#lastRequestStartedAt + interval - Date.now();
            if (waitMs > 0) {
                await sleep(waitMs);
            }
            this.#lastRequestStartedAt = Date.now();
        });
        // Keep the chain alive even if a waiter is abandoned.
        this.#gate = ticket.catch(() => undefined);
        await ticket;
    }

    #buildUrl(path: string, query?: Record<string, QueryValue>): URL {
        const url = new URL(`${this.config.baseUrl}/${path.replace(/^\/+/, '')}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, String(value));
            }
        }
        return url;
    }

    async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const url = this.#buildUrl(path, options.query);
        const retry = options.retry ?? true;

        let lastError: VwoApiError | undefined;

        for (let attempt = 1; attempt <= (retry ? MAX_ATTEMPTS : 1); attempt++) {
            await this.#waitForSlot();

            const headers: Record<string, string> = {
                [this.config.authHeader]: this.config.token,
                Accept: 'application/json'
            };
            if (options.body !== undefined) {
                headers['Content-Type'] = 'application/json';
            }

            log.debug(`${method} ${url.pathname}${url.search} (attempt ${attempt})`);

            let response: Response;
            try {
                response = await fetch(url, {
                    method,
                    headers,
                    signal: AbortSignal.timeout(this.config.requestTimeoutMs),
                    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                lastError = new VwoApiError(`network error: ${reason}`, undefined, method, url.pathname);
                if (attempt < MAX_ATTEMPTS && retry) {
                    await sleep(2 ** (attempt - 1) * 500);
                    continue;
                }
                throw lastError;
            }

            if (response.ok) {
                if (response.status === 204) {
                    return undefined as T;
                }
                const text = await response.text();
                if (text.trim() === '') {
                    return undefined as T;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    throw new VwoApiError(
                        `VWO returned a non-JSON success body: ${redact(text.slice(0, MAX_ERROR_BODY_CHARS))}`,
                        response.status,
                        method,
                        url.pathname
                    );
                }

                // A 2xx does not guarantee success: VWO returns errors in-band.
                const envelopeError = extractErrorEnvelope(parsed);
                if (envelopeError !== undefined) {
                    throw new VwoApiError(
                        `VWO returned HTTP ${response.status} with an error payload — ${envelopeError}`,
                        response.status,
                        method,
                        url.pathname,
                        envelopeError
                    );
                }

                return parsed as T;
            }

            const rawBody = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS);
            // Prefer VWO's structured message over the raw JSON blob.
            let detail = rawBody;
            try {
                detail = extractErrorEnvelope(JSON.parse(rawBody)) ?? rawBody;
            } catch {
                /* not JSON — keep the raw text */
            }
            lastError = new VwoApiError(
                `HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
                response.status,
                method,
                url.pathname,
                detail
            );

            if (!lastError.retryable || !retry || attempt === MAX_ATTEMPTS) {
                throw lastError;
            }

            const retryAfterSeconds = Number(response.headers.get('retry-after'));
            const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? retryAfterSeconds * 1000
                : 2 ** (attempt - 1) * 1000;
            log.warn(`Retrying after ${backoffMs}ms`, lastError.message);
            await sleep(backoffMs);
        }

        /* istanbul ignore next — loop always returns or throws */
        throw lastError ?? new VwoApiError('request failed', undefined, method, url.pathname);
    }

    get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
        return this.request<T>('GET', path, query === undefined ? {} : { query });
    }

    post<T = unknown>(path: string, body: unknown, query?: Record<string, QueryValue>): Promise<T> {
        return this.request<T>('POST', path, { body, retry: false, ...(query === undefined ? {} : { query }) });
    }

    patch<T = unknown>(path: string, body: unknown, query?: Record<string, QueryValue>): Promise<T> {
        return this.request<T>('PATCH', path, { body, retry: false, ...(query === undefined ? {} : { query }) });
    }

    delete<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
        return this.request<T>('DELETE', path, { retry: false, ...(query === undefined ? {} : { query }) });
    }
}
