import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", ".vite", ".continuum", "artifacts"]);
const conflicts: string[] = [];

async function walk(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\s\d+\.[^/]+$/.test(entry.name)) conflicts.push(relative(root, path));
  }
}

await walk(root);
if (conflicts.length) {
  process.stderr.write(`Finder-style conflict copies are not allowed in source or documentation:\n${conflicts.sort().map((path) => `- ${path}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("No source-tree conflict copies found.\n");
}
