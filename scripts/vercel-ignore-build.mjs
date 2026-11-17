import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directories = {
  www: "apps/www",
  collage: "apps/collage",
  drive: "products/drive",
  trackmap: "apps/trackmap",
  stay: "apps/stay",
};
const sha = /^[a-f0-9]{40}$/;

export function shouldBuild(app, environment = process.env, execute = execFileSync) {
  try {
    if (!Object.hasOwn(directories, app)) return true;
    const directory = directories[app];
    const before = environment.VERCEL_GIT_PREVIOUS_SHA;
    const head = environment.VERCEL_GIT_COMMIT_SHA;
    if (!sha.test(before ?? "") || !sha.test(head ?? "") || /^0+$/.test(before)) return true;
    const git = args => execute("git", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const root = git(["rev-parse", "--show-toplevel"]).trim();
    if (git(["-C", root, "rev-parse", "HEAD"]).trim() !== head) return true;
    const files = git(["-C", root, "diff", "--name-only", "-z", "--no-renames", before, head])
      .split("\0").filter(Boolean);
    return files.some(file => {
      if (file.startsWith(`${directory}/`) || file.startsWith("packages/")) return true;
      if (file.startsWith("apps/") || file.startsWith("products/")) return false;
      if (file.startsWith(".github/")) return false;
      if (["README.md", "AGENTS.md", "SOURCE_PROVENANCE.json", ".gitignore"].includes(file)) return false;
      if (/^scripts\/[^/]+\.test\.mjs$/.test(file)) return false;
      if (["scripts/release-vercel.mjs", "scripts/require-release-checks.mjs", "scripts/vercel-ignore-build.mjs"].includes(file)) return false;
      return true;
    });
  } catch {
    return true;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , flag, app, ...extra] = process.argv;
  const build = flag !== "--app" || extra.length > 0 || shouldBuild(app);
  console.log(build ? "Build required for application inputs or unavailable change history." : "Skipping build: application inputs are unchanged.");
  process.exit(build ? 1 : 0);
}
