#!/usr/bin/env node

/**
 * consolidate — turn the adapter's per-skill results.json files into the PR
 * summary markdown, replacing `skill-validator evaluate consolidate` plus the
 * downstream Python column-stripper.
 *
 * Each results.json (written by adapt.mjs) has:
 *   { model, judgeModel, timestamp, verdicts: [ {
 *       skillName, passed, meanScore, confidenceInterval:{low,high},
 *       winRate, wins, ties, losses, trialCount, erroredCount, reason,
 *       scenarios: [ { scenarioName, skilledIsolated:{judgeResult:{overallScore}},
 *                      skilledPlugin?:{judgeResult:{overallScore}},
 *                      baseline:{judgeResult:{overallScore}} } ]
 *   } ] }
 *
 * A skill's verdict is head-to-head preference of skilled vs baseline (judged by
 * `vally compare`): it PASSES only on a credible improvement (mean preference > 0
 * with its 95% CI above 0). Absolute per-role quality is shown for context.
 *
 * Both formats render a table (Overfit + Skills Loaded columns included),
 * followed by a legend and a collapsible <details> per skill that carries the
 * verdict reason and a per-scenario preference table.
 *
 * Two formats:
 *   --format full    every column incl. Quality (Plugin)  — for the step summary
 *   --format simple  drops Quality (Plugin)                — for the PR comment
 *
 * Usage:
 *   node consolidate.mjs --format simple --output body.md <results.json...>
 *   node consolidate.mjs --format full --root all-results/ --output summary.md
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: opts, positionals } = parseArgs({
  options: {
    format: { type: "string", default: "full" },
    output: { type: "string" },
    root: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (opts.help || (opts.format !== "full" && opts.format !== "simple")) {
  console.log(`Usage:
  node consolidate.mjs --format <full|simple> [--output <file>] [--root <dir>] [<results.json>...]

Consolidates per-skill results.json into a markdown summary table.

Options:
  --format <full|simple>  full: all columns (step summary). simple: drop Quality
                          (Plugin) column (PR comment). (required)
  --output <file>         Write markdown here (default: stdout).
  --root <dir>            Recursively discover results.json under <dir> (in
                          addition to any explicit file arguments).
  --help                  Show this help`);
  process.exit(opts.help ? 0 : 1);
}

function findResultsJson(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findResultsJson(full));
    else if (entry.name === "results.json") out.push(full);
  }
  return out;
}

const files = [...positionals];
if (opts.root) {
  try {
    if (statSync(opts.root).isDirectory()) files.push(...findResultsJson(opts.root));
  } catch {
    /* missing root dir — treated as no files */
  }
}

// Dedupe while preserving order.
const uniqueFiles = [...new Set(files)];

function mean(nums) {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Mean absolute quality (0-5) across a verdict's scenarios for one role.
function roleQuality(verdict, role) {
  return mean(
    (verdict.scenarios ?? []).map((s) => s?.[role]?.judgeResult?.overallScore),
  );
}

function fmtQuality(q) {
  return q === null ? "—" : `${q.toFixed(1)}/5`;
}

function pct(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

// Overfitting-judge severity → icon + score, mirroring the old Reporter.cs
// FormatOverfitCell (Low=✅, Moderate=🟡, High=🔴, missing=—).
function fmtOverfit(verdict) {
  const r = verdict.overfittingResult;
  if (!r || !r.severity) return "—";
  const icon =
    { Low: "✅", Moderate: "🟡", High: "🔴" }[r.severity] ?? "—";
  const score = typeof r.score === "number" ? ` ${r.score.toFixed(2)}` : "";
  return `${icon}${score}`;
}

// Skill-activation coverage from scenarios: "activated/total" for the isolated
// run (plus the plugin run when present), with a ⚠️ when a scenario that
// expected activation didn't activate.
function activationCell(verdict) {
  const scenarios = verdict.scenarios ?? [];
  if (scenarios.length === 0) return "—";
  const total = scenarios.length;
  const isoActive = scenarios.filter((s) => s?.skillActivationIsolated?.activated).length;
  const hasPlugin = scenarios.some((s) => s?.skillActivationPlugin != null);
  const missingExpected = scenarios.some(
    (s) =>
      s?.expectActivation !== false &&
      (!s?.skillActivationIsolated?.activated ||
        (s?.skillActivationPlugin != null && !s.skillActivationPlugin.activated)),
  );
  let cell = `${isoActive}/${total}`;
  if (hasPlugin) {
    const plugActive = scenarios.filter((s) => s?.skillActivationPlugin?.activated).length;
    cell += ` · ${plugActive}/${total} (plugin)`;
  }
  return missingExpected ? `⚠️ ${cell}` : cell;
}

// Per-scenario preference table (mirrors evaluation-run.yml's step summary).
function scenarioTable(verdict) {
  const rows = ["| Scenario | Mean preference | Trials (W/T/L) |", "|---|---|---|"];
  for (const s of verdict.scenarios ?? []) {
    const m = typeof s.meanScore === "number" ? s.meanScore : 0;
    const icon = m > 0 ? "▲" : m < 0 ? "▼" : "=";
    let w = 0, t = 0, l = 0;
    for (const tr of s.trials ?? []) {
      if (tr.score > 0) w++;
      else if (tr.score < 0) l++;
      else t++;
    }
    rows.push(`| ${icon} ${s.scenarioName} | ${pct(m)} | ${w}/${t}/${l} |`);
  }
  return rows;
}

const verdicts = [];
for (const file of uniqueFiles) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`::warning::consolidate: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  for (const v of data.verdicts ?? []) verdicts.push(v);
}

verdicts.sort((a, b) => (a.skillName ?? "").localeCompare(b.skillName ?? ""));

const passedCount = verdicts.filter((v) => v.passed).length;
const failedCount = verdicts.length - passedCount;

const isFull = opts.format === "full";

const header = isFull
  ? ["Skill", "Result", "Δ Preference [95% CI]", "W/T/L", "Quality (Isolated)", "Quality (Plugin)", "Baseline", "Overfit", "Skills Loaded"]
  : ["Skill", "Result", "Δ Preference [95% CI]", "W/T/L", "Quality", "Baseline", "Overfit", "Skills Loaded"];

const lines = [];
lines.push(`## 📊 Skill Evaluation Results`);
lines.push("");
lines.push(
  `${verdicts.length} skill(s) evaluated — **${passedCount} improved**, **${failedCount} no credible improvement**. ` +
    `A skill passes only on a credible improvement over baseline (mean preference > 0 with its 95% CI above 0).`,
);
lines.push("");

if (verdicts.length === 0) {
  lines.push("_No skill verdicts were produced._");
} else {
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const v of verdicts) {
    const result = v.passed ? "✅" : "❌";
    const ci = v.confidenceInterval
      ? ` [${pct(v.confidenceInterval.low)}, ${pct(v.confidenceInterval.high)}]`
      : "";
    const pref = `${pct(v.meanScore)}${ci}`;
    const wtl = `${v.wins ?? 0}/${v.ties ?? 0}/${v.losses ?? 0}`;
    const isolated = fmtQuality(roleQuality(v, "skilledIsolated"));
    const plugin = fmtQuality(roleQuality(v, "skilledPlugin"));
    const baseline = fmtQuality(roleQuality(v, "baseline"));
    const overfit = fmtOverfit(v);
    const activation = activationCell(v);
    const cells = isFull
      ? [v.skillName, result, pref, wtl, isolated, plugin, baseline, overfit, activation]
      : [v.skillName, result, pref, wtl, isolated, baseline, overfit, activation];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  // Legend / glossary — kept out of table cells so it renders reliably.
  lines.push("<details><summary>ℹ️ Column legend</summary>");
  lines.push("");
  lines.push("- **Δ Preference** — mean head-to-head preference of skilled vs baseline (−100%…+100%), judged by `vally compare`.");
  lines.push("- **[95% CI]** — 95% confidence interval on that mean; a skill passes only when the whole interval is above 0.");
  lines.push("- **W/T/L** — wins / ties / losses across trials.");
  lines.push("- **Quality / Baseline** — mean absolute judge score 0–5 (skilled isolated vs skill-free control).");
  if (isFull) {
    lines.push("- **Quality (Plugin)** — mean absolute judge score 0–5 for the whole-plugin run.");
  }
  lines.push("- **Overfit** — overfitting-judge severity (✅ Low, 🟡 Moderate, 🔴 High, — none) with its score.");
  lines.push("- **Skills Loaded** — scenarios where the skill actually activated / total (plugin run shown when present); ⚠️ marks a scenario that expected activation but didn't activate.");
  lines.push("</details>");
  lines.push("");

  // Per-skill detail: verdict reason + per-scenario preference table, one click away.
  for (const v of verdicts) {
    const icon = v.passed ? "✅" : "❌";
    lines.push(`<details><summary>${icon} ${v.skillName} — details</summary>`);
    lines.push("");
    if (v.reason) lines.push(`**Reason:** ${v.reason}`);
    lines.push("");
    lines.push(...scenarioTable(v));
    lines.push("");
    lines.push("</details>");
  }
}
lines.push("");

const markdown = lines.join("\n");
if (opts.output) {
  writeFileSync(opts.output, markdown);
  console.error(`Wrote ${opts.format} summary (${verdicts.length} skill(s)) to ${opts.output}`);
} else {
  process.stdout.write(markdown + "\n");
}
