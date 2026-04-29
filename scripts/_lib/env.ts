/**
 * Explicit .env loader so the script's environment matches the file the
 * operator edits, even when the agent's shell has stale exports.
 *
 * Why: agent containers (Hermes, OpenClaw, custom) often inherit wallets,
 * agent IDs, or model keys from a parent process. We discovered AGENT_ID=5263
 * leaking from an unrelated bot's shell, overriding AGENT_ID=3906 in .env and
 * causing every commit to be signed for the wrong agent. Bun loads .env but
 * shell env wins by default — we invert that here.
 *
 * Usage: import { loadEnv } from "./_lib/env"; loadEnv();
 *   - looks for .env in cwd, then walks up to project root
 *   - parses KEY=VALUE (with optional quotes); ignores #-comments
 *   - sets process.env.KEY = VALUE for every entry, *overwriting* prior values
 *   - returns the parsed object so callers can also use it directly
 */

import {readFileSync, existsSync} from "node:fs";
import {dirname, resolve, sep} from "node:path";

export function loadEnv(startDir: string = process.cwd()): Record<string, string> {
    const path = findEnvFile(startDir);
    if (!path) {
        process.stderr.write(`[env] no .env found from ${startDir} upwards — skipping\n`);
        return {};
    }
    const text = readFileSync(path, "utf8");
    const parsed = parseDotEnv(text);
    for (const [k, v] of Object.entries(parsed)) {
        process.env[k] = v;
    }
    return parsed;
}

function findEnvFile(startDir: string): string | null {
    let dir = resolve(startDir);
    // Walk up to the filesystem root, but stop after 8 levels to avoid runaway.
    for (let i = 0; i < 8; i++) {
        const candidate = resolve(dir, ".env");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir || parent === sep) return null;
        dir = parent;
    }
    return null;
}

function parseDotEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // strip matching quotes
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

/**
 * Read a required env var with a single, focused error message. Use after
 * loadEnv(). The error mentions the variable name so an agent can self-heal.
 */
export function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`[env] missing required ${name} — set it in .env or process env`);
    return v;
}
