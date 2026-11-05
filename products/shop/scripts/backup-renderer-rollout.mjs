import { setTimeout } from "node:timers/promises";

export async function readBackupContainer(wrangler, id, accountId) {
  // The dashboard list can retain an older image/version after provisioning.
  // Read configuration and health together from the exact application instead.
  const application = JSON.parse(await wrangler(["containers", "info", id, "--json"]));
  const health = application?.health, instances = health?.instances;
  if (application?.id !== id || application.account_id !== accountId ||
      typeof application.name !== "string" || !Number.isSafeInteger(application.version) || application.version < 1 ||
      typeof application.configuration?.image !== "string" || !application.configuration.image ||
      !Array.isArray(health?.errors) || !instances ||
      !["failed", "starting", "scheduling", "active"].every(key => Number.isSafeInteger(instances[key]) && instances[key] >= 0)) {
    throw Error("Backup renderer stopped: exact container configuration and health required.");
  }
  const state = health.errors.length || instances.failed > 0 ? "degraded"
    : instances.starting > 0 || instances.scheduling > 0 ? "provisioning"
    : instances.active > 0 ? "active" : "ready";
  return { id, name: application.name, image: application.configuration.image, version: application.version, state };
}

export async function waitForBackupPair(inspect, before, image, { attempts = 41, pause = () => setTimeout(15000) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const deployed = await inspect();
    if (deployed.container.id !== before.container.id ||
        ![before.container.image, image].includes(deployed.container.image)) {
      throw Error("Backup renderer stopped: unexpected container change during rollout.");
    }
    if (deployed.container.image === image && deployed.container.state === "ready" &&
        deployed.container.version === before.container.version + 1 && deployed.workerVersion !== before.workerVersion) return deployed;
    if (attempt + 1 < attempts) await pause();
  }
  throw Error("Backup renderer stopped: new backup pair not confirmed before the rollout deadline.");
}
