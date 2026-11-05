import { pathToFileURL } from "node:url";
import { assertProductionIdentityContext } from "./native-production-identity.mjs";

const PROJECT = "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS", TEAM = "team_ru36uQa1rhHA6N5wW0lblUkz";
const check = (value, reason) => { if (!value) throw new Error(`Production storefront inspection stopped: ${reason}`); };

export async function inspectProductionStorefront(env = process.env, request = fetch) {
  assertProductionIdentityContext(env);
  check(env.VERCEL_PROJECT_ID === PROJECT && env.VERCEL_ORG_ID === TEAM &&
    typeof env.VERCEL_TOKEN === "string" && env.VERCEL_TOKEN.length > 0, "exact personal project configuration.");
  const response = await request(`https://api.vercel.com/v9/projects/${PROJECT}?teamId=${TEAM}`, {
    redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
  });
  check(response.ok, `read returned HTTP ${response.status}.`);
  const project = await response.json();
  check(project.id === PROJECT && project.accountId === TEAM && project.name === "forever-tee-web" &&
    project.rootDirectory === "apps/web", "project identity and root.");
  check(project.link === null || project.link === undefined, "a Git connection could deploy outside the reviewed Actions workflow.");
  const target = project.targets?.production;
  check(/^dpl_[A-Za-z0-9]+$/.test(target?.id ?? "") && target.target === "production" && target.readyState === "READY" &&
    Array.isArray(target.alias) && target.alias.includes("shop.bent.build") &&
    /^[a-f0-9]{40}$/.test(target.meta?.githubCommitSha ?? ""), "existing Production deployment and domain.");
  // Project responses may contain environment configuration. Never return or
  // log the full response, deployment metadata, or arbitrary settings.
  return { productionStorefrontInspected: true, projectId: PROJECT, teamId: TEAM, rootDirectory: "apps/web",
    gitConnected: false, deploymentId: target.id, deployedSourceCommit: target.meta.githubCommitSha,
    domain: "shop.bent.build", inspectionSourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    applicationMutations: false, nativePromotionReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.info(JSON.stringify(await inspectProductionStorefront())); }
  catch (error) { console.error(error instanceof Error && error.message.startsWith("Production storefront inspection stopped:")
    ? error.message : "Production storefront inspection failed; response content was not logged."); process.exitCode = 1; }
}
