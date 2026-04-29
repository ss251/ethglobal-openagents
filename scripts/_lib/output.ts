/**
 * Output helpers — BigInt-safe JSON, stderr stepper, fatal handler.
 *
 * The agent reads stdout as a single JSON object after the script exits,
 * and narrates stderr while the script runs. Mixing the two corrupts the
 * agent's view of "did it succeed?" so we keep them strictly separated:
 *   - process.stderr.write for human/agent narration
 *   - process.stdout.write for the final JSON only
 */

export function step(...m: unknown[]): void {
    process.stderr.write(m.join(" ") + "\n");
}

/** JSON.stringify replacer that turns BigInt into string (no truncation). */
export function bigIntReplacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value;
}

/** Emit the canonical final result and exit. Always BigInt-safe. */
export function emitResult(result: unknown): void {
    process.stdout.write(JSON.stringify(result, bigIntReplacer, 2) + "\n");
}

/** Wrap main() so any throw becomes structured JSON + non-zero exit. */
export function runMain(scenario: string, main: () => Promise<unknown>): void {
    main()
        .then(result => {
            if (result !== undefined) emitResult(result);
        })
        .catch((err: unknown) => {
            const e = err as {shortMessage?: string; message?: string};
            const msg = e?.shortMessage || e?.message || String(err);
            process.stderr.write(`\n[FATAL] ${msg}\n`);
            emitResult({scenario, status: "Failed", error: msg});
            process.exit(1);
        });
}
