import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

export function standaloneBackupConfig(source, renderer) {
  const config = structuredClone(source);
  config.main = resolve(renderer, config.main);
  // Wrangler validates paths in the top level and unselected environments too.
  // Its temporary config directory is not the renderer's source directory.
  for (const selected of [config, ...Object.values(config.env)]) {
    selected.assets.directory = resolve(renderer, selected.assets.directory);
    for (const container of selected.containers) {
      if (container.image.startsWith(".")) container.image = resolve(renderer, container.image);
    }
  }
  return config;
}

export async function prepareBackupContext(directory) {
  const renderer = join(repository, "workers/video-renderer");
  await mkdir(join(directory, "src"), { recursive: true });
  for (const name of ["Dockerfile", "package.json"]) {
    await copyFile(join(renderer, name), join(directory, name));
  }
  for (const name of ["server", "server-auth", "renderer", "geometry", "version", "stored-render", "storage-contract"]) {
    await copyFile(join(renderer, `src/${name}.mjs`), join(directory, `src/${name}.mjs`));
  }
  // The repository bridge points outside Docker's build context. Include the
  // canonical module bytes, just as the Lambda source packager does.
  await copyFile(join(repository, "packages/contracts/src/product-mockup-geometry.js"),
    join(directory, "src/product-mockup-geometry.mjs"));
  return directory;
}
