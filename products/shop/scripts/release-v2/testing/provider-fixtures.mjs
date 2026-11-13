import { createServer } from 'node:http';
import { canonical, digest, parseJSON, same, sha256 } from '../data.mjs';
import { fixtureTransportByteLimit, verifyContent } from '../artifact-transport.mjs';

export async function simulator(options = {}) {
  const state = { active: [], versions: [], operations: [], reports: [], jobs: [], calls: [], physicalEffects: 0, contents: {}, ...options.state };
  const controls = { ...options };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const call = { method: request.method, path: url.pathname, startedAt: Date.now() }; state.calls.push(call);
    const send = (status, value) => {
      const bytes = canonical(value);
      call.response = { status, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes), finishedAt: Date.now(),
        ...(url.pathname.startsWith('/content/') ? {} : { value: structuredClone(value) }) };
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(bytes);
    };
    try {
      if (controls.delayMs) await new Promise(accept => setTimeout(accept, controls.delayMs));
      if (controls.redirect) { response.writeHead(307, { location: 'https://example.invalid/denied' }); response.end(); return; }
      if (controls.httpError && (!controls.errorPath || url.pathname === controls.errorPath)) return send(503, { error: 'fixture-outage' });
      if (request.method === 'GET') {
        if (url.pathname === '/inventory') return send(200, { complete: !controls.truncated, active: controls.wrongActive ?? state.active, versions: state.versions, jobs: state.jobs });
        if (url.pathname === '/runtime') return send(200, { complete: true, active: controls.wrongRuntime ?? state.active });
        if (url.pathname.startsWith('/content/')) {
          const content = state.contents[url.pathname.slice('/content/'.length)];
          return content ? send(200, controls.wrongContent ?? content) : send(404, { error: 'missing-content' });
        }
        if (url.pathname.startsWith('/operations/')) {
          const id = url.pathname.split('/').at(-1), records = state.operations.filter(item => item.id === id);
          return send(200, { complete: !controls.truncatedOperations, records: controls.hideOperations ? [] : controls.duplicateOperations ? [...records, ...records] : records });
        }
        if (url.pathname.startsWith('/reports/')) return send(200, { complete: !controls.truncatedReports, records: controls.hideReports ? [] : state.reports.filter(item => item.eventId === url.pathname.split('/').at(-1)) });
        return send(404, { error: 'unknown-route' });
      }
      const chunks = []; for await (const bytes of request) chunks.push(bytes);
      const wire = Buffer.concat(chunks), body = parseJSON(wire, fixtureTransportByteLimit);
      call.request = { bytes: wire.length, sha256: sha256(wire) };
      const kind = url.pathname.slice(1);
      if (controls.dropBefore === kind) { request.socket.destroy(); return; }
      if (kind === 'reports') {
        if (controls.reportOutage) return send(503, { error: 'report-outage' });
        if (state.reports.some(item => item.eventId === body.eventId)) return send(409, { error: 'duplicate-report' });
        state.reports.push(body);
      } else if (kind === 'stage' || kind === 'activate') {
        if (state.operations.some(item => item.id === body.id)) return send(409, { error: 'duplicate-operation' });
        const before = state.active.find(item => item.component === body.component)?.version ?? null;
        if (body.expectedActiveVersion !== before) return send(412, { error: 'revision-conflict' });
        const result = { component: body.component, artifactDigest: body.artifactDigest, configDigest: body.configDigest, version: body.version };
        if (kind === 'stage') {
          verifyContent(body.upload, { artifact: body.artifact, config: body.config, provenance: body.provenance });
          state.contents[`${body.component}/${body.version}`] = structuredClone(body.upload);
          if (!state.versions.some(item => same(item, result))) state.versions.push(result);
        } else {
          if (!state.versions.some(item => same(item, result))) return send(409, { error: 'unstaged' });
          if (!controls.delayedActivation) state.active = state.active.filter(item => item.component !== result.component).concat(result);
        }
        state.operations.push({ id: body.id, kind, bodyDigest: digest(body), result });
      } else { state.physicalEffects++; return send(403, { error: 'physical-effect-forbidden' }); }
      if (controls.dropAfter === kind) { request.socket.destroy(); return; }
      return send(200, { accepted: true });
    } catch { if (!response.destroyed) send(400, { error: 'malformed-fixture-request' }); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  return { state, controls, origin: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  } };
}
