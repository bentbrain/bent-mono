import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { get, put } from "@vercel/blob";
import ts from "typescript";
import { ZodError } from "zod";
import { defaultGuideIntro } from "../src/lib/guide-types.ts";
import {
  guideDocumentSchema,
  guideStateSchema,
} from "../src/lib/guide-cms-types.ts";
import { normalizeGuideLinks } from "../src/lib/guide-content-policy.ts";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string" },
    "backup-dir": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
async function existing(pathname: string) {
  const response = await get(pathname, {
    access: "private",
    useCache: false,
    headers: { "Accept-Encoding": "identity" },
  });
  if (!response) return null;
  if (response.statusCode !== 200)
    throw new Error("Private storage returned an unexpected response.");
  return new Uint8Array(await new Response(response.stream).arrayBuffer());
}

let stage = "arguments";
async function main() {
  if (!values["source-root"] || !values["backup-dir"])
    throw new Error(
      "Provide --source-root and --backup-dir outside the public repository. Default is read-only; --apply uploads missing objects.",
    );
  const source = path.resolve(values["source-root"]);
  const backup = path.resolve(values["backup-dir"]);
  const publicRoot = path.resolve(import.meta.dirname, "../../..");
  if (
    backup === publicRoot ||
    backup.startsWith(publicRoot + path.sep) ||
    source === publicRoot ||
    source.startsWith(publicRoot + path.sep)
  )
    throw new Error(
      "Private source and backup must be outside the public repository.",
    );
  stage = "private source read";
  const originalGuide = await readFile(
    path.join(source, "src/content/guide.ts"),
    "utf8",
  );
  const originalLinkSource = await readFile(
    path.join(source, "src/lib/home-control-link.ts"),
    "utf8",
  );
  const oldLink = /localHomeControlsUrl\s*=\s*["']([^"']+)["']/.exec(
    originalLinkSource,
  )?.[1];
  if (!oldLink)
    throw new Error(
      "Original controls URL could not be identified; no changes made.",
    );
  const dataStart = originalGuide.indexOf("export const home");
  if (dataStart < 0)
    throw new Error("Original guide format is unsupported; no changes made.");
  const javascript = ts.transpileModule(
    `const localHomeControlsUrl = ${JSON.stringify(oldLink)};\nconst defaultGuideIntro = ${JSON.stringify(defaultGuideIntro)};\n${originalGuide.slice(dataStart)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    },
  ).outputText;
  stage = "private source conversion";
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await chmod(backup, 0o700);
  const sourceModule = path.join(
    backup,
    `source-${digest(Buffer.from(javascript))}.mjs`,
  );
  try {
    await writeFile(sourceModule, javascript, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  const sourceValues: unknown = await import(pathToFileURL(sourceModule).href);
  const document = guideDocumentSchema.parse(
    normalizeGuideLinks(sourceValues, oldLink),
  );
  stage = "private CMS read";
  const current = await existing("guide/content.json");
  if (current) {
    stage = "private CMS validation";
    guideStateSchema.parse(
      normalizeGuideLinks(
        JSON.parse(new TextDecoder().decode(current)),
        oldLink,
      ),
    );
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await chmod(backup, 0o700);
    const filename = path.join(backup, `content-${digest(current)}.json`);
    try {
      await writeFile(filename, current, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    console.log(
      "Existing published and draft CMS state verified and backed up privately. It will not be overwritten.",
    );
  }
  stage = "private asset inventory";
  const assets = [
    ["location-kitchen-cupboards.webp", "kitchen-cupboards.webp", "image/webp"],
    ["location-laundry.webp", "laundry.webp", "image/webp"],
    ["location-linen-cupboard.webp", "linen-cupboard.webp", "image/webp"],
    ["evacuation-level3.jpeg", "evacuation.jpeg", "image/jpeg"],
  ];
  const pending = [];
  for (const [filename, name, contentType] of assets) {
    if (!filename || !name || !contentType)
      throw new Error("Invalid asset configuration.");
    const bytes = await readFile(
      path.join(source, "src/content/assets", filename),
    );
    const pathname = `guide/assets/${name}`;
    const stored = await existing(pathname);
    if (stored && digest(stored) !== digest(bytes))
      throw new Error(
        "Existing private asset differs; no objects will be overwritten.",
      );
    if (!stored) pending.push({ pathname, bytes, contentType });
  }
  const controlsPathname = "guide/home-controls.json";
  const controlsBytes = Buffer.from(JSON.stringify({ url: oldLink }));
  const storedControls = await existing(controlsPathname);
  if (storedControls && digest(storedControls) !== digest(controlsBytes))
    throw new Error(
      "Existing private controls configuration differs; no objects will be overwritten.",
    );
  if (!storedControls)
    pending.push({
      pathname: controlsPathname,
      bytes: controlsBytes,
      contentType: "application/json",
    });
  console.log(
    JSON.stringify({
      mode: values.apply ? "apply" : "read-only",
      existingCmsPreserved: Boolean(current),
      missingCms: !current,
      missingObjects: pending.length,
    }),
  );
  if (!values.apply) return;
  for (const asset of pending) {
    await put(asset.pathname, asset.bytes, {
      access: "private",
      contentType: asset.contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    const stored = await existing(asset.pathname);
    if (!stored || digest(stored) !== digest(asset.bytes))
      throw new Error(
        "Private asset verification failed; keep the original app deployed.",
      );
  }
  if (!current) {
    const state = guideStateSchema.parse({
      version: 1,
      revision: "private-source-import",
      published: document,
      draft: document,
      savedAt: null,
      publishedAt: null,
    });
    await put("guide/content.json", JSON.stringify(state), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    const stored = await existing("guide/content.json");
    if (
      !stored ||
      JSON.stringify(
        guideStateSchema.parse(JSON.parse(new TextDecoder().decode(stored))),
      ) !== JSON.stringify(state)
    )
      throw new Error(
        "Private content verification failed; keep the original app deployed.",
      );
  }
  console.log(
    "Private objects verified. Original source and assets retained. Deployment cutover still requires authenticated app verification.",
  );
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      stage,
      category: error instanceof Error ? error.name : "unknown",
      issues:
        error instanceof ZodError
          ? error.issues.map((issue) => ({
              path: issue.path,
              code: issue.code,
            }))
          : undefined,
    }),
  );
  console.error(
    "Private preparation failed. No existing objects were overwritten. Check protected configuration and source/backup paths; keep the original app deployed.",
  );
  process.exitCode = 1;
});
