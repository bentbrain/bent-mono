import { readFileSync } from 'node:fs';
import { z } from 'zod';

const contract = z.object({
  file: z.string(),
  test: z.string(),
  cases: z.array(z.string()).optional(),
});
const original = z.object({
  caseId: z.string(),
  file: z.string(),
  titlePath: z.array(z.string()).min(2),
  perPrBrowser: z.boolean(),
  fullBrowser: z.literal(true),
  perPrContracts: z.array(contract),
  representatives: z.array(z.string()),
  disposition: z.string().min(1),
});
const manifest = z.object({
  schemaVersion: z.literal(1),
  sourcePin: z.string(),
  canonicalReportSha256: z.string(),
  originalCaseCount: z.literal(333),
  cases: z.array(original).length(333),
  additionalCases: z.array(original.omit({ caseId: true })),
});
export const browserCoverage = manifest.parse(
  JSON.parse(
    readFileSync(new URL('../browser-coverage.json', import.meta.url), 'utf8'),
  ),
);
export function caseKey(file: string, titlePath: string[]) {
  return JSON.stringify([
    file.replace(/^tests\/browser\//, ''),
    ...titlePath.slice(1),
  ]);
}
export function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export const fullOnlyPattern = new RegExp(
  browserCoverage.cases
    .filter((entry) => !entry.perPrBrowser)
    .map((entry) => `(?:^| )${entry.titlePath.map(escapePattern).join(' ')}$`)
    .join('|') || '(?!)',
);
