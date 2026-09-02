#!/usr/bin/env node
/**
 * Explicit-`any` ratchet — GAP-TYPE-001.
 *
 * Counts violations of ONE rule (@typescript-eslint/no-explicit-any) and fails
 * when the count rises above a recorded baseline. The debt may shrink; it may
 * never grow.
 *
 * Why not `eslint --max-warnings N`:
 *   That caps EVERY warning together, so it does not say what it appears to.
 *   Fix an unrelated `import/first` warning and the budget silently makes room
 *   for a new `any`; reduce `any` without lowering the cap and the reclaimed
 *   headroom lets it creep straight back. A ratchet has to count the one thing
 *   it is ratcheting.
 *
 * Production source and specs are counted SEPARATELY. Test doubles have real
 * reasons to be loosely typed (mocks, partial fixtures), so holding them to the
 * same line as shipped code would either block sensible test code or force the
 * production limit up to accommodate it.
 *
 *   node scripts/any-ratchet.mjs            check against the baseline
 *   node scripts/any-ratchet.mjs --report   check, then list the worst files
 *   node scripts/any-ratchet.mjs --update   re-baseline, DOWNWARD ONLY
 */

import { ESLint } from "eslint";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "any-baseline.json");
const RULE = "@typescript-eslint/no-explicit-any";

const argv = new Set(process.argv.slice(2));

/** Anything generated, vendored, or not ours — never counted, never cleaned. */
const EXCLUDED = /(^|\/)(node_modules|dist|coverage)\//;

const isSpec = (p) => /(\.(spec|test)\.[tj]sx?$)|(^|\/)__tests__\//.test(p);

async function count(targets) {
  const eslint = new ESLint({
    cwd: ROOT,
    // The rule is forced on here rather than read from the repo config: the
    // ratchet must measure the same thing regardless of whether the config
    // currently has it at warn, error, or off. The backend has it off entirely
    // and still needs a ceiling.
    overrideConfig: { rules: { [RULE]: "error" } },
  });

  const results = await eslint.lintFiles(targets);
  const byFile = new Map();
  let source = 0;
  let spec = 0;

  for (const result of results) {
    const rel = path.relative(ROOT, result.filePath);
    if (EXCLUDED.test(rel)) continue;
    const hits = result.messages.filter((m) => m.ruleId === RULE).length;
    if (!hits) continue;
    byFile.set(rel, hits);
    if (isSpec(rel)) spec += hits;
    else source += hits;
  }

  return { source, spec, total: source + spec, byFile };
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const actual = await count(baseline.targets);

const lines = [
  `explicit \`any\` — ${path.basename(ROOT)}`,
  `  production source  ${actual.source}  (ceiling ${baseline.source})`,
  `  specs/tests        ${actual.spec}  (${
    baseline.enforceSpec ? `ceiling ${baseline.spec}` : "tracked, non-blocking"
  })`,
];
console.log(lines.join("\n"));

if (argv.has("--report")) {
  console.log("\nworst files:");
  [...actual.byFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`));
}

if (argv.has("--update")) {
  // Downward only. A ratchet you can loosen is a suggestion — if a change
  // genuinely needs more `any` than the ceiling allows, that is a conversation,
  // not a silent number bump.
  const next = {
    ...baseline,
    source: Math.min(baseline.source, actual.source),
    spec: Math.min(baseline.spec, actual.spec),
  };
  if (next.source === baseline.source && next.spec === baseline.spec) {
    console.log("\nbaseline unchanged — it only ever moves down.");
  } else {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `\nbaseline lowered: source ${baseline.source} → ${next.source}, specs ${baseline.spec} → ${next.spec}`,
    );
  }
  process.exit(0);
}

const failures = [];
if (actual.source > baseline.source) {
  failures.push(
    `production source rose ${baseline.source} → ${actual.source}`,
  );
}
if (baseline.enforceSpec && actual.spec > baseline.spec) {
  failures.push(`specs rose ${baseline.spec} → ${actual.spec}`);
}

if (failures.length) {
  console.error(`\n✖ explicit \`any\` debt increased:`);
  failures.forEach((f) => console.error(`    ${f}`));
  console.error(
    "\n  Use a real type, or `unknown` plus a narrowing guard.\n" +
      "  Do NOT reach for `as unknown as T` to get past this — that hides the\n" +
      "  same hole behind a longer spelling and the ratchet stops meaning\n" +
      "  anything.\n" +
      "\n  Run with --report to see where the debt is concentrated.",
  );
  process.exit(1);
}

// Lower than the ceiling is not an error, but it IS a missed opportunity: an
// unlowered baseline hands back exactly the room that was just cleaned up.
if (
  actual.source < baseline.source ||
  (baseline.enforceSpec && actual.spec < baseline.spec)
) {
  console.log(
    "\n↓ below the ceiling — run `npm run lint:any -- --update` to lock the gain in.",
  );
}
console.log("\n✓ explicit `any` debt has not increased.");
