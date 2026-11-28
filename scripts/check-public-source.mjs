import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function sourceProblems(path, contents) {
  const problems = [];
  const parts = path.split("/");
  const name = parts.at(-1);
  if (
    parts.some((part) =>
      [
        "private",
        ".vercel",
        ".wrangler",
        ".clerk",
        ".terraform",
        "migration-artifacts",
        "review-data",
      ].includes(part),
    )
  ) {
    problems.push("private runtime or operational directory");
  }
  if (
    (name.startsWith(".env") &&
      ![".env.example", ".env.test.example"].includes(name)) ||
    (name.startsWith(".dev.vars") && name !== ".dev.vars.example")
  ) {
    problems.push("non-example environment file");
  }
  if (/\.(?:sqlite(?:3)?|db|tfstate)(?:\.|$)/.test(name))
    problems.push("private database or infrastructure state");
  if (name.endsWith(".tfvars"))
    problems.push("private infrastructure variables");
  if (
    name === "pnpm-lock.yaml" ||
    (name === "bun.lock" && path !== "bun.lock") ||
    name === "package-lock.json"
  ) {
    problems.push("unexpected secondary package-manager lockfile");
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents))
    problems.push("private key material");
  if (
    /\/Users\/(?!example(?:\/|$)|test(?:\/|$)|user(?:\/|$))[A-Za-z][\w.-]*\//.test(
      contents,
    )
  )
    problems.push("personal local filesystem path");
  return problems;
}

export function auditSource(root = process.cwd()) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const path of files) {
    const content = readFileSync(resolve(root, path));
    const text = content.includes(0) ? "" : content.toString("utf8");
    for (const category of sourceProblems(path, text))
      findings.push({ path, category });
  }
  return { files: files.length, findings };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = auditSource();
  for (const finding of report.findings)
    console.error(`${finding.path}: ${finding.category}`);
  console.log(
    `Public-source policy checked ${report.files} files; ${report.findings.length} findings.`,
  );
  if (report.findings.length) process.exitCode = 1;
}
