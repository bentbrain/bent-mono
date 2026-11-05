import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ACCOUNT, BUCKET, FUNCTION_ARN, NAME, REGION } from "./config.mjs";
import { infrastructure } from "./infrastructure.mjs";
import {
  packageSource,
  SOURCE_FILES,
  sourceFilePath,
} from "./package-source.mjs";
import { prepareFixture, uploadFixture } from "./prepare-fixture.mjs";
import { jobsFor } from "./benchmark-core.mjs";
import { ROOT } from "./local-tools.mjs";
import { sha256 } from "./contract.mjs";

test("infrastructure stays private, capped, personal-account-only and separately deployable", () => {
  const template = infrastructure();
  assert.deepEqual(template.Rules.PersonalAccountOnly.Assertions.map((rule) => rule.Assert["Fn::Equals"][1]), [ACCOUNT, REGION]);
  const resources = template.Resources;
  assert.equal(resources.Function.Condition, "HasImage");
  assert.equal(resources.Function.Properties.FunctionName, NAME);
  assert.deepEqual(resources.Function.Properties.ReservedConcurrentExecutions, { "Fn::If": ["ReserveCapacity", 8, { Ref: "AWS::NoValue" }] });
  assert.equal(template.Parameters.CapacityMode.Default, "reserved-eight");
  assert.deepEqual(template.Parameters.CapacityMode.AllowedValues, ["reserved-eight", "sequential-smoke"]);
  assert.equal(resources.Function.Properties.Timeout, 120);
  assert.equal(resources.Function.Properties.PackageType, "Image");
  assert.equal(Object.values(resources).some((resource) => ["AWS::Lambda::Url", "AWS::Lambda::Permission", "AWS::Lambda::EventSourceMapping"].includes(resource.Type)), false);
  assert.equal(JSON.stringify(template).includes("ProvisionedConcurrency"), false);
  assert.equal(resources.Build.Properties.ConcurrentBuildLimit, 1);
  assert.equal(resources.Bucket.Properties.BucketName, BUCKET);
  assert.equal(Object.values(resources.Bucket.Properties.PublicAccessBlockConfiguration).every(Boolean), true);
  assert.equal(resources.Bucket.DeletionPolicy, "Retain");
  assert.equal(resources.Repository.Properties.RepositoryPolicyText.Statement[0].Condition.ArnLike["aws:SourceArn"], FUNCTION_ARN);
  const role = resources.RenderRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(role.map((statement) => statement.Resource), [
    `arn:aws:s3:::${BUCKET}/inputs/*`, `arn:aws:s3:::${BUCKET}/outputs/*`, `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${NAME}:*`,
  ]);
  assert.equal(JSON.stringify(role).includes("iam:"), false);
  assert.equal(JSON.stringify(role).includes("s3:Delete"), false);
});

test("source packaging uses only explicit code files and produces a verified deployment bundle", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "story-lambda-package-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = await packageSource(directory);
  const exec = promisify(execFile);
  const { stdout } = await exec("/usr/bin/unzip", ["-Z1", bundle.zip]);
  assert.deepEqual(stdout.trim().split("\n").sort(), ["bundle-manifest.json", ...SOURCE_FILES].sort());
  assert.equal(SOURCE_FILES.some((path) => /\.env|\.data|credentials|\.png|\.webp/.test(path)), false);
  const { stdout: manifest } = await exec("/usr/bin/unzip", ["-p", bundle.zip, "bundle-manifest.json"]);
  assert.equal(sha256(manifest), bundle.sourceDigest);
  for (const [path, hash] of Object.entries(JSON.parse(manifest).files)) {
    assert.equal(sha256(await readFile(sourceFilePath(path))), hash);
  }
  assert.deepEqual(JSON.parse(await readFile(bundle.template)), infrastructure());
  // Exercise the actual cloud verifier, not a second implementation of its rules.
  const extracted = resolve(directory, "extracted");
  await exec("/usr/bin/unzip", ["-q", bundle.zip, "-d", extracted]);
  const verified = await exec(process.execPath, ["aws-lambda/verify-bundle.mjs"], {
    cwd: extracted, env: { PATH: "/usr/bin:/bin", SOURCE_DIGEST: bundle.sourceDigest },
  });
  assert.match(verified.stdout, /Verified the isolated source bundle/);
  await writeFile(resolve(extracted, "aws-lambda/Dockerfile"), "corrupt");
  await assert.rejects(exec(process.execPath, ["aws-lambda/verify-bundle.mjs"], {
    cwd: extracted, env: { PATH: "/usr/bin:/bin", SOURCE_DIGEST: bundle.sourceDigest },
  }), /source file mismatch/);
});

test("source geometry resolves before workspace dependencies are installed", async () => {
  const source = await readFile(new URL("../src/product-mockup-geometry.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/packages\/contracts\/src\/product-mockup-geometry\.js"/);
  assert.doesNotMatch(source, /@forever-tee\/contracts/);
});

test("fixture preparation preserves saved settings; corrupt local assets cannot upload", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "story-lambda-fixture-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Header-only fixture: no decoding or encoding occurs in this unit test.
  await writeFile(resolve(directory, "artwork.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const example = JSON.parse(await readFile(resolve(ROOT, "workers/video-renderer/aws-lambda/saved-design.example.json")));
  await writeFile(resolve(directory, "source.json"), JSON.stringify({ ...example, artworkPath: "artwork.png" }));
  const path = await prepareFixture(resolve(directory, "source.json"), resolve(directory, "assets"));
  const fixture = JSON.parse(await readFile(path));
  assert.equal(jobsFor(fixture, 2).length, 8);
  assert.deepEqual(fixture.variants[0].settings, example.settings["staple-tee"]);
  assert.deepEqual(fixture.variants[3].settings, example.settings["cotton-tote"]);
  const operations = [];
  const uploaded = await uploadFixture(path, async (args) => {
    operations.push(args);
    if (args[1] === "head-bucket" || args[1] === "head-object") {
      assert.equal(args[args.indexOf("--expected-bucket-owner") + 1], ACCOUNT);
      assert.equal(args[args.indexOf("--bucket") + 1], BUCKET);
    }
    if (args[1] === "cp") {
      const upload = fixture.uploads.find((upload) => upload.path === args[2]);
      assert.ok(upload);
      assert.equal(args[3], `s3://${BUCKET}/${upload.key}`);
      assert.equal(args[args.indexOf("--metadata") + 1], `sha256=${upload.sha256}`);
    }
    if (args[1] === "head-object") {
      const upload = fixture.uploads.find((upload) => upload.key === args[args.indexOf("--key") + 1]);
      assert.ok(upload);
      return { ContentLength: upload.size, Metadata: { sha256: upload.sha256 } };
    }
  });
  assert.deepEqual(uploaded, { uploaded: 5, bucket: BUCKET });
  assert.deepEqual(operations.map((args) => args[1]), ["head-bucket", ...Array(5).fill(["cp", "head-object"]).flat()]);
  await assert.rejects(uploadFixture(path, async (args) => args[1] === "head-object"
    ? { ContentLength: 0, Metadata: { sha256: "wrong" } } : undefined), /verification failed/);
  let calls = 0;
  await writeFile(fixture.uploads[0].path, "corrupted");
  await assert.rejects(uploadFixture(path, async () => { calls++; }), /changed/);
  assert.equal(calls, 0);
});
