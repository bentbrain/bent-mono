# Development print executor

This private Worker owns the `PrintAssetExecution` Durable Object namespace.
It imports the same D1 claims and print renderer as the API. Its default fetch
handler returns 404; customers cannot submit work over a public route. The
unnamed environment has local resources only. Deploy this configuration to Development only.
The existing API toolchain bundles this Worker without another dependency set:

```sh
bun run --filter @forever-tee/api exec wrangler deploy --dry-run --config ../print-executor/wrangler.jsonc --env development
```

Only guarded GitHub Actions may perform a real deployment. A successful local
bundle does not authorize or prove a cloud release.

## Why a separate Worker

Cloudflare does not allow a historical-version rollback across a Durable Object
class lifecycle change, including the legacy `migrations` array. Creating the
print class in the API Worker would invalidate its previous version as a rollback
target. A completed job drain does not remove this restriction.

The API binds the existing namespace using
`script_name: forever-tee-print-executor-development`. Namespace creation and
subsequent lifecycle changes belong to this executor Worker. No new class export
or class migration belongs in the API Worker. Binding to an existing external
class is a binding configuration change, not a class lifecycle operation. The
exact API rollback still requires cloud qualification; documentation alone is
not proof that a deployed release is reversible.

Sources:
[Cloudflare rollback constraints](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
[external namespace binding](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects),
[Durable Object class lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

## Required guarded release lifecycle

Follow this release design through the application's guarded release admission,
evidence and rollback tooling.

1. **Prepare a source-bound executor artifact in protected Preview.** Pin the
   exact Worker name, Cloudflare account, D1 database and R2 bucket. Build the
   reviewed source in Actions and preserve bundle checksum, all modules,
   configuration digest, source commit and migration inventory in immutable
   release evidence. Inspect the live executor before mutation. Record an exact
   absent-resource baseline for first creation, or the live version ID and its
   resource digest for an update. Fail on an unrecorded existing Worker.
2. **Provision before activating the API binding.** Create the new namespace in
   this separate Worker while the API still uses its existing queue renderer.
   Record the deployed executor version, actual namespace identity and settings.
   Keep the namespace and its evidence on a failed first application release;
   do not delete it to simulate rollback. First creation is a separate foundation
   operation, not a version rollback to a nonexistent Worker.
3. **Bind the exact executor into the application release.** Preserve the current
   immutable API/video pair before enabling direct scheduling. The release
   evidence must include the verified executor version/configuration. Reject
   another executor version or namespace before the API mutation. A mutable
   cross-script binding alone does not pin the executing code.
4. **Qualify jobs and rollback together.** Test a three-family burst, image
   equivalence, committed readiness, interrupted work, duplicate wakeups and
   bounded admission. Roll back the exact API/video versions through the existing
   guarded workflow and verify the binding is removed/restored as expected.
   Newly accepted old-executor jobs must remain fenced by D1 job leases and
   immutable asset identity. Do not declare the rollback successful based only
   on a successful deployment API response.
5. **Include prints in pause/drain before executor upgrades.** The guarded
   pause installs print claim triggers as well as video guards. Development
   waits for live print leases and recovers only expired attempts; Production
   requires natural completion without expiring attempts. A new executor version must not
   replace old code while delayed alarms or running print work can execute an
   unrecorded renderer. Admission must observe a durable release/pause or executor
   generation fence; wait for all live print leases to settle or expire without
   clearing them early. Pending jobs remain durable for the selected executor.
   API rollback cannot stop alarms in another Worker by removing its binding.
   `PRINT_EXECUTION_RELEASE_ID` identifies the immutable executor generation.
   An atomic D1 claim requires an unpaused control row whose current release's
   immutable verified event authorizes that generation at
   `worker.printExecutor.releaseId`. A paused alarm retains its intent and
   retries after 15 seconds. An unauthorized generation retires its wakeup while
   leaving the D1 outbox for the restored API's recovery path. A rollback can
   authorize the exact historical executor under its new application release ID.
   Queue API rollback records `retainedPrintExecutor` for ownership only; it does
   not authorize that executor to claim jobs.
   The current queue consumer retries paused delivery after 15 seconds.
   Historical consumers can acknowledge pause-rejected claims; after verification,
   resume makes only their unclaimed dispatched jobs due now. Recovery then waits
   for the active API's normal cron interval; it is not an immediate queue send.
   Running leases and pending failure backoffs are preserved. Subsequent guarded
   Development updates preserve the same namespace and class and require exact
   owned version/source/resource evidence. Class migrations and unknown existing
   executors fail closed; Production namespace provisioning remains excluded.
6. **Restore a recorded executor version on later executor rollbacks.** Pause
   admissions, drain print execution, restore the recorded API/video/executor
   versions and matching binding configuration, verify the full set, then
   resume. Never cross an executor namespace lifecycle migration in this route.
   Preserve an inactive executor namespace if the restored API no longer uses it.

Alarms are at-least-once and Cloudflare runs one alarm callback at a time per
object. A request may arrive during an alarm. Generation checks preserve those
new wakeups; prearmed recovery retains intent after interruption. A capacity
refusal backs off from 1 to 2 to 4 to 5 seconds, remaining capped at 5 seconds.
Duplicate wake requests cannot reset this counter or bypass a known lease delay.
D1 owns admission and attempts; scheduling retries do not claim processing
capacity or consume a print attempt. These controls require actual load tests;
five concurrent families is an experiment limit, not proof of 100 designs/minute.

[Cloudflare alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/)

Admission reserves free slots for the oldest eligible family revisions using a
materialized D1 decision. Pending failure backoff and live sibling leases are
excluded; equal creation times use the immutable revision ID. When another family
has priority, a refused caller restores up to five older private wakeups before
retaining its own bounded retry. This prevents missing original alarms from
silently stranding priority. Existing alarm deadlines are preserved, so saturated
handoff can still wait up to five seconds. Wake failures retain the outbox and
retry; no processing attempt is consumed by a priority refusal. The partial
admission index excludes historical completed jobs, but ranking still scans the
unfinished backlog. Sustained-load qualification must measure that D1 cost and
alarm overhead separately from the three-family latency gate.
