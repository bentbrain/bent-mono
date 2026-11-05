import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = resolve(root, '../review-data/feedback.json');
const port = Number(process.env.JP_REVIEW_PORT || 4317);
const tokenFile = resolve(root, '../review-data/tunnel-token');
const originFile = resolve(root, '../review-data/tunnel-origin');
await mkdir(dirname(tokenFile), { recursive: true });
let reviewToken;
try { reviewToken = (await readFile(tokenFile, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  reviewToken = randomBytes(24).toString('base64url');
  await writeFile(tokenFile, reviewToken, { mode: 0o600, flag: 'wx' });
}
function matchesToken(value) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value), expected = Buffer.from(reviewToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function publicOrigin() {
  try { return (await readFile(originFile, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
const surfaces = new Set(['journal', 'post', 'gallery', 'viewer', 'map', 'login', 'posts', 'editor', 'media', 'export']);
let writeQueue = Promise.resolve();
async function notes() {
  try { return JSON.parse(await readFile(dataFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (Buffer.byteLength(value) > 16000) throw new Error('Feedback is too long.');
  }
  return JSON.parse(value);
}
function validNote(value) {
  return value && typeof value === 'object' && surfaces.has(value.surface)
    && typeof value.target === 'string' && /^[a-z0-9-]{1,100}$/.test(value.target)
    && typeof value.label === 'string' && value.label.length <= 140
    && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 4000
    && ['desktop', 'mobile'].includes(value.viewport) && typeof value.dark === 'boolean'
    && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1
    && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;
}
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const hostname = new URL(`http://${request.headers.host || ''}`).hostname;
    const remote = Boolean(request.headers['cf-connecting-ip']) || !['localhost', '127.0.0.1'].includes(hostname);
    if (remote) {
      if (matchesToken(url.searchParams.get('review'))) {
        response.writeHead(303, { 'Set-Cookie': `jp_review=${reviewToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`, 'Location': url.pathname, 'Cache-Control': 'no-store' });
        return response.end();
      }
      const cookie = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('jp_review='));
      if (!matchesToken(cookie?.slice('jp_review='.length))) return json(response, 401, { error: 'Open the private review link provided in chat.' });
    }
    if (url.pathname === '/api/feedback') {
      if (request.method === 'GET') return json(response, 200, await notes());
      if (request.method === 'PATCH') {
        if (remote) return json(response, 403, { error: 'Responses can be updated only from the local agent.' });
        const input = await body(request);
        const valid = Array.isArray(input.responses) && input.responses.length <= 32 && input.responses.every(item => item && typeof item.id === 'string' && /^[0-9a-f-]{36}$/.test(item.id) && ['addressed', 'answered', 'open'].includes(item.status) && typeof item.response === 'string' && item.response.length <= 4000 && typeof item.responseRevision === 'string' && /^r[1-9][0-9]{0,3}$/.test(item.responseRevision));
        if (!valid) return json(response, 400, { error: 'Invalid feedback responses.' });
        let updated = 0;
        const operation = writeQueue.then(async () => {
          const existing = await notes();
          for (const reply of input.responses) {
            const note = existing.find(item => item.id === reply.id);
            if (!note) continue;
            Object.assign(note, { status: reply.status, response: reply.response, responseRevision: reply.responseRevision, respondedAt: new Date().toISOString() });
            updated += 1;
          }
          const temporary = `${dataFile}.tmp`;
          await writeFile(temporary, `${JSON.stringify(existing, null, 2)}\n`);
          await rename(temporary, dataFile);
        });
        writeQueue = operation.catch(() => {});
        await operation;
        return json(response, 200, { updated });
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed.' });
      const origin = request.headers.origin;
      const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, await publicOrigin()];
      if ((remote && !origin) || (origin && !allowed.includes(origin))) return json(response, 403, { error: 'Save feedback from the review page.' });
      const input = await body(request);
      if (!validNote(input)) return json(response, 400, { error: 'Select an element and enter feedback.' });
      const revision = typeof input.revision === 'string' && /^r[1-9][0-9]{0,3}$/.test(input.revision) ? input.revision : 'r5';
      const note = { id: randomUUID(), revision, surface: input.surface, target: input.target, label: input.label, viewport: input.viewport, dark: input.dark, x: input.x, y: input.y, text: input.text.trim(), status: 'open', createdAt: new Date().toISOString() };
      const operation = writeQueue.then(async () => {
        const existing = await notes();
        existing.push(note);
        await mkdir(dirname(dataFile), { recursive: true });
        const temporary = `${dataFile}.tmp`;
        await writeFile(temporary, `${JSON.stringify(existing, null, 2)}\n`);
        await rename(temporary, dataFile);
      });
      writeQueue = operation.catch(() => {});
      await operation;
      return json(response, 201, note);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });
    const path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const filename = resolve(root, `.${path}`);
    if (!filename.startsWith(`${root}/`) || !types[extname(filename)]) return json(response, 404, { error: 'Not found.' });
    const content = await readFile(filename);
    const headers = { 'Content-Type': types[extname(filename)], 'Cache-Control': 'private, no-store' };
    if (extname(filename) === '.mp4' && request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match) { response.writeHead(416); return response.end(); }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
      if (start > end) { response.writeHead(416); return response.end(); }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      return response.end(content.subarray(start, end + 1));
    }
    response.writeHead(200, { ...headers, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    json(response, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? 'Not found.' : 'Unable to complete request.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Japan mockup review: http://127.0.0.1:${port}`));
