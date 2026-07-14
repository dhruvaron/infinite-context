import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { glob } from "node:fs/promises";

type Finding = { severity: "critical" | "warning"; file: string; rule: string; excerpt: string };
const root = process.cwd();
const findings: Finding[] = [];
const ignored = ["node_modules/", ".git/", "dist/", "coverage/", "IMPLEMENTATION_PLAN.md", "scripts/security-audit.ts"];
const rules = [
  { rule: "provider-storage", severity: "critical" as const, pattern: /store\s*:\s*true/g },
  { rule: "browser-secret-storage", severity: "critical" as const, pattern: /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\([^\n]*(?:token|secret|api.?key)/gi },
  { rule: "raw-html", severity: "critical" as const, pattern: /dangerouslySetInnerHTML/g },
  // A leading dot would be RegExp.exec/SQLite.exec rather than a child-process helper.
  { rule: "shell-execution", severity: "warning" as const, pattern: /(?<![.\w-])(?:exec|execSync)\s*\(/g },
  { rule: "wildcard-cors", severity: "critical" as const, pattern: /origin\s*:\s*["']\*["']/g },
  { rule: "api-key-literal", severity: "critical" as const, pattern: /sk-[A-Za-z0-9_-]{20,}/g }
];

for await (const relative of glob("**/*.{ts,tsx,js,jsx,json,md,yaml,yml}", { cwd: root })) {
  if (ignored.some((segment) => relative.includes(segment))) continue;
  const content = await readFile(resolve(root, relative), "utf8");
  for (const rule of rules) {
    // Test-only canaries deliberately look like provider keys to verify that exports redact them.
    if (rule.rule === "api-key-literal" && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)) continue;
    for (const match of content.matchAll(rule.pattern)) {
      findings.push({ severity: rule.severity, file: relative, rule: rule.rule, excerpt: match[0].slice(0, 120) });
    }
  }
}
const critical = findings.filter((finding) => finding.severity === "critical");
process.stdout.write(JSON.stringify({ passed: critical.length === 0, findings }, null, 2) + "\n");
if (critical.length > 0) process.exitCode = 1;
