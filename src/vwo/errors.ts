import { redact } from '../redact.js';

/** An error that knows how to phrase itself as guidance for the model. */
export interface AgentFacingError extends Error {
    readonly agentMessage: string;
}

export function isAgentFacingError(error: unknown): error is AgentFacingError {
    return error instanceof Error && typeof (error as AgentFacingError).agentMessage === 'string';
}

/**
 * A local precondition failure — no HTTP request was attempted.
 *
 * Kept distinct from {@link VwoApiError} so its message reaches the model as
 * plain guidance, without an "HTTP request failed" framing that would imply the
 * call reached VWO and might be worth retrying.
 */
export class VwoToolError extends Error implements AgentFacingError {
    override readonly name = 'VwoToolError';

    constructor(message: string) {
        super(redact(message));
    }

    get agentMessage(): string {
        return this.message;
    }
}

/**
 * An error from the VWO API or the transport underneath it.
 *
 * `agentMessage` is what gets returned to the model: redacted, and phrased so
 * the agent can act on it rather than retry blindly.
 */
export class VwoApiError extends Error implements AgentFacingError {
    override readonly name = 'VwoApiError';

    constructor(
        message: string,
        readonly status: number | undefined,
        readonly method: string,
        readonly path: string,
        readonly body?: string
    ) {
        super(redact(message));
    }

    /** True when retrying the identical request could plausibly succeed. */
    get retryable(): boolean {
        return this.status === undefined || this.status === 429 || this.status >= 500;
    }

    get agentMessage(): string {
        const where = `${this.method} ${this.path}`;
        switch (this.status) {
            case 401:
            case 403:
                return (
                    `VWO rejected the request as unauthorized (${this.status}) on ${where}. ` +
                    'The configured API token is missing, invalid, or lacks the required permission ' +
                    'scope. This is a server configuration problem — the user must fix their token; ' +
                    'do not retry.'
                );
            case 404:
                return `VWO returned 404 Not Found for ${where}. The referenced resource does not exist or is not visible to this token.`;
            case 429:
                return `VWO rate-limited the request (429) on ${where}. VWO permits 1 request/second per token; wait before retrying.`;
            default:
                break;
        }
        if (this.status !== undefined && this.status >= 500) {
            return `VWO returned a server error (${this.status}) on ${where}. This is upstream; retrying later may succeed.`;
        }
        return `VWO request failed on ${where}: ${this.message}`;
    }
}
