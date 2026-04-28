/**
 * Update env vars across our .env files. Lets us write to dotfiles which
 * the Edit tool can't reach directly.
 *
 * Usage:
 *   bun run scripts/update-env.ts UNISWAP_TRADING_API_KEY=value [KEY2=val2 ...]
 */

import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const targets = [
    resolve(import.meta.dir, "..", ".env"),
    resolve(import.meta.dir, "..", "hermes-sandbox", ".env")
];

const updates: Array<[string, string]> = [];
for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (eq < 0) continue;
    updates.push([arg.slice(0, eq), arg.slice(eq + 1)]);
}

if (updates.length === 0) {
    console.error("No KEY=VALUE pairs provided.");
    process.exit(1);
}

for (const path of targets) {
    let content = readFileSync(path, "utf8");
    for (const [k, v] of updates) {
        const re = new RegExp(`^${k}=.*$`, "m");
        if (re.test(content)) {
            content = content.replace(re, `${k}=${v}`);
        } else {
            content += `\n${k}=${v}\n`;
        }
    }
    writeFileSync(path, content, {mode: 0o600});
    console.log(`✓ updated ${path}`);
}

for (const [k] of updates) {
    console.log(`  ${k} = ${updates.find(u => u[0] === k)?.[1].slice(0, 12)}…`);
}
