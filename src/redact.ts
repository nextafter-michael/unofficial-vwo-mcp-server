/**
 * Central secret-redaction registry.
 *
 * Anything that could reach a log line, an error message, or a tool result gets
 * run through {@link redact} first. The API token must never appear in any of
 * those: tool results are fed straight back into the model's context, and logs
 * are frequently pasted into bug reports.
 */

const secrets = new Set<string>();

/** Registers a value to be scrubbed from all future redacted output. */
export function registerSecret(value: string | undefined): void {
    // Very short values would cause absurd over-redaction of unrelated text.
    if (value && value.length >= 8) {
        secrets.add(value);
    }
}

/** Replaces every registered secret in `input` with a fixed placeholder. */
export function redact(input: string): string {
    let output = input;
    for (const secret of secrets) {
        output = output.replaceAll(secret, '[REDACTED]');
    }
    return output;
}

/**
 * Renders an unknown thrown value as a redacted, single-line string suitable
 * for a log line or a tool result.
 */
export function redactError(error: unknown): string {
    if (error instanceof Error) {
        return redact(error.message);
    }
    return redact(String(error));
}

/** Shows only the last 4 characters, for confirming *which* token is loaded. */
export function tokenFingerprint(token: string): string {
    if (token.length <= 4) {
        return '****';
    }
    return `****${token.slice(-4)}`;
}
