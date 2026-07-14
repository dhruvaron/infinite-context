import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  aggregateCompetitorCaptures,
  competitorComparisonMarkdown,
  validateCompetitorCapture
} from "./competitor-capture.js";

function argumentsFor(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  });
  return values;
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const capturePaths = argumentsFor("--capture");
if (capturePaths.length === 0) throw new Error("Pass one or more manually completed capture files with --capture");
const outputDirectory = resolve(argument("--output", "artifacts/evaluation/competitors/latest")!);
const captures = await Promise.all(capturePaths.map((path) => validateCompetitorCapture(resolve(path))));
const result = aggregateCompetitorCaptures(captures);
const markdown = competitorComparisonMarkdown(result);
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
  writeFile(resolve(outputDirectory, "report.md"), markdown, { encoding: "utf8", mode: 0o600 })
]);
process.stdout.write(`${JSON.stringify({
  outputDirectory,
  captures: result.captures.length,
  products: result.aggregates.map((aggregate) => aggregate.product),
  resultHash: result.resultHash,
  evidenceClass: result.evidenceClass,
  warning: "Descriptive black-box evidence only; no causal or internal-system claim."
}, null, 2)}\n`);
