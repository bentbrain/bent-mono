import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const numericMetrics = new Set(['hashCalls','hashBytes','hashNs','readCalls','readBytes','readNs','cacheInventoryCalls','cacheInventoryEntries','cacheInventoryNs','cacheHits','cacheMisses','cacheWrites','httpRequests','httpBodyBytes','userCpuUs','systemCpuUs','maxRss','fsRead','fsWrite','eventLoopMaxUs','eventLoopUtilizationBp','stdoutBytes','stderrBytes','elapsedMs','invalidMessages','sampleErrors']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const steps = new Set(['child-start','entrypoint-start','intake-start','intake-complete','assembly-start','assembly-complete','controller-start','controller-complete','fixture-start','fixture-complete','source-a-start','source-a-complete','source-b-start','source-b-complete','outer-cancelled']);
const phases = new Set(['','plan-admitted','prepared','runtime-verified','reporting-pending','report-intent','report-reconcile','complete','staging','stage-intent','stage-reconcile','staged-verified','activate-intent','activate-reconcile','activating']);

export function validateProofObservation(value) {
  assert(exact(value, ['schema','invocation','at','kind','details']));
  assert.equal(value.schema, 'shop.workflow-proof-observation/v1');
  assert(typeof value.invocation === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.invocation));
  assert(integer(value.at));
  const detail = value.details;
  if (value.kind === 'child') {
    assert(exact(detail, ['step','command','phase','metrics']));
    assert(steps.has(detail.step) && (detail.command === '' || ['plan','begin','advance','deliver','rollback','recover-report'].includes(detail.command)) && phases.has(detail.phase));
    assert(detail.metrics && Object.entries(detail.metrics).every(([key, number]) => numericMetrics.has(key) && integer(number)));
  } else if (value.kind === 'processes') {
    assert(exact(detail, ['pid','processes'])); assert(integer(detail.pid) && detail.pid > 0);
    assert(Array.isArray(detail.processes) && detail.processes.length <= 128);
    for (const item of detail.processes) {
      assert(exact(item, ['pid','ppid','pgid','cpuBasisPoints','rssKiB','cpuTimeMs']));
      assert(Object.values(item).every(integer));
    }
  } else if (value.kind === 'start') {
    assert(exact(detail, ['pid','timeoutMs'])); assert(integer(detail.pid) && integer(detail.timeoutMs));
  } else if (value.kind === 'stop') {
    assert(exact(detail, ['pid','reason'])); assert(integer(detail.pid)); assert(['abort','timeout','overflow','stream-error'].includes(detail.reason));
  } else if (value.kind === 'close') {
    assert(exact(detail, ['pid','exitCode','signal','aborted','timedOut','overflow','reaped','remainingPids','metrics']));
    assert(integer(detail.pid) && (detail.exitCode === null || integer(detail.exitCode)) && (detail.signal === null || Object.hasOwn(osConstants.signals,detail.signal)));
    assert(['aborted','timedOut','overflow','reaped'].every(key => typeof detail[key] === 'boolean'));
    assert(Array.isArray(detail.remainingPids) && detail.remainingPids.length <= 128 && detail.remainingPids.every(integer));
    assert(Object.entries(detail.metrics).every(([key, number]) => numericMetrics.has(key) && integer(number)));
  } else throw Error('Unknown proof observation');
  return value;
}

export async function processGroupSnapshot(pid) {
  const { stdout } = await execute('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,pcpu=,rss=,time='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => {
    const parts = line.trim().split(/\s+/); if (parts.length !== 6) return null;
    const times = parts[5].split(':').map(Number); if (times.some(value => !Number.isFinite(value))) return null;
    let seconds = 0; for (const time of times) seconds = seconds * 60 + time;
    return { pid: Number(parts[0]), ppid: Number(parts[1]), pgid: Number(parts[2]), cpuBasisPoints: Math.round(Number(parts[3]) * 100), rssKiB: Number(parts[4]), cpuTimeMs: Math.round(seconds * 1000) };
  }).filter(Boolean);
  const members = rows.filter(row => row.pgid === pid); assert(members.length <= 128, 'Proof process group exceeds diagnostic bound');
  assert(members.every(row => Object.values(row).every(integer)), 'Invalid process resource observation');
  return members;
}

// Only fixed labels and numeric measurements cross IPC. Configuration, request
// headers, bodies, source paths and original stdout/stderr are never messages.
export function installProofTelemetry() {
  if (!process.send || process.env.SHOP_WORKFLOW_DIAGNOSTICS !== '1') return () => {};
  const metrics = { hashCalls:0,hashBytes:0,hashNs:0,readCalls:0,readBytes:0,readNs:0,cacheInventoryCalls:0,cacheInventoryEntries:0,cacheInventoryNs:0,cacheHits:0,cacheMisses:0,cacheWrites:0,httpRequests:0,httpBodyBytes:0 };
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable(); let current = { step:'child-start', command:'', phase:'' };
  const send = () => {
    if (!process.connected) return;
    const usage = process.resourceUsage(), loop = performance.eventLoopUtilization();
    process.send({ schema:'shop.workflow-proof-child/v1', ...current, metrics:{ ...metrics, userCpuUs:usage.userCPUTime,systemCpuUs:usage.systemCPUTime,maxRss:usage.maxRSS,fsRead:usage.fsRead,fsWrite:usage.fsWrite,eventLoopMaxUs:Math.round(delay.max / 1000),eventLoopUtilizationBp:Math.round(loop.utilization * 10000) } }, () => {});
  };
  const costs = channel('shop.release-v2.cost'), workflow = channel('shop.release-v2.workflow'), requests = channel('undici:request:create');
  const cost = event => {
    if (event.kind === 'hash') { metrics.hashCalls++; metrics.hashBytes += event.bytes; metrics.hashNs += event.ns; }
    if (event.kind === 'regular-read') { metrics.readCalls++; metrics.readBytes += event.bytes; metrics.readNs += event.ns; }
    if (event.kind === 'cache-inventory') { metrics.cacheInventoryCalls++; metrics.cacheInventoryEntries += event.entries; metrics.cacheInventoryNs += event.ns; }
    if (event.kind === 'cache-hit') metrics.cacheHits++;
    if (event.kind === 'cache-miss') metrics.cacheMisses++;
    if (event.kind === 'cache-write') metrics.cacheWrites++;
  };
  const transition = event => { current = { step:event.step, command:event.command ?? '', phase:event.phase ?? '' }; send(); };
  const request = ({ request }) => { metrics.httpRequests++; const length = Number(request.contentLength); if (integer(length)) metrics.httpBodyBytes += length; };
  costs.subscribe(cost); workflow.subscribe(transition); requests.subscribe(request);
  send(); const timer = setInterval(send, 1000); timer.unref();
  return () => { send(); clearInterval(timer); delay.disable(); costs.unsubscribe(cost); workflow.unsubscribe(transition); requests.unsubscribe(request); };
}

export function recordProofBoundary(output, step) {
  const usage=process.resourceUsage();
  const value=validateProofObservation({schema:'shop.workflow-proof-observation/v1',invocation:'source-proof',at:Date.now(),kind:'child',details:{step,command:'',phase:'',metrics:{userCpuUs:usage.userCPUTime,systemCpuUs:usage.systemCPUTime,maxRss:usage.maxRSS,fsRead:usage.fsRead,fsWrite:usage.fsWrite}}});
  appendFileSync(join(output,'source-proof-profile.private.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});
}
