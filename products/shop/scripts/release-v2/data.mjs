import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const check = (condition, reason) => { if (!condition) throw Error(reason); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
export const digest = value => sha256(canonical(value));
export const same = (a, b) => canonical(a) === canonical(b);

// Token validation follows native-worker-content's complete-json-data-v1
// discipline. JSON.parse owns JSON syntax; this pass rejects duplicate keys
// and ambiguous numbers before its otherwise lossy object construction.
export function parseJSON(bytes, maximumBytes = 1024 * 1024) {
  check(bytes.byteLength <= maximumBytes, 'JSON exceeds declared byte bound');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  // Artifact transport contains multi-megabyte base64 strings. Scan string
  // boundaries iteratively so valid bounded input cannot exhaust RegExp's
  // backtracking stack. JSON.parse above already owns lexical validity.
  const tokens = [];
  for (let cursor = 0; cursor < text.length;) {
    const start = cursor, character = text[cursor++];
    if (/\s/.test(character)) continue;
    if (character === '"') {
      while (cursor < text.length) {
        const next = text[cursor++];
        if (next === '\\') cursor++;
        else if (next === '"') break;
      }
    } else if (/[0-9-]/.test(character)) {
      while (cursor < text.length && /[0-9.eE+-]/.test(text[cursor])) cursor++;
    } else if (character === 't' || character === 'n') cursor += 3;
    else if (character === 'f') cursor += 4;
    tokens.push(text.slice(start, cursor));
  }
  const stack = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    if (token.startsWith('"')) check(JSON.parse(token).isWellFormed(), 'Malformed Unicode string');
    if (token === '{' || token === '[') {
      check(stack.length < 64, 'JSON nesting exceeds 64');
      stack.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[at + 1] === ':') {
      const keys = stack.at(-1), key = JSON.parse(token);
      check(keys instanceof Set && !keys.has(key), 'Duplicate JSON key');
      keys.add(key);
      check(!['__proto__', 'constructor', 'prototype'].includes(key), 'Reserved JSON key');
    } else if (/^-?[0-9]/.test(token)) {
      const number = Number(token);
      check(Number.isSafeInteger(number) && !Object.is(number, -0) && String(number) === token, 'Ambiguous JSON number');
    }
  }
  return parsed;
}

export const readJSON = async (path, maximumBytes) => parseJSON(await readFile(path), maximumBytes);
export function pathName(path) {
  check(typeof path === 'string' && path.isWellFormed() && path.length <= 512 && /^[^\x00-\x1f\x7f\\:?#%]+$/u.test(path) &&
    !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Malformed relative path');
  return path;
}
export async function confined(root, path) {
  pathName(path);
  const base = await realpath(root), target = resolve(base, path);
  check(target.startsWith(`${base}${sep}`), 'Path escapes bundle');
  let cursor = base;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    check(!(await lstat(cursor)).isSymbolicLink(), 'Symlinks are forbidden');
  }
  check(await realpath(target) === target, 'Path identity changed');
  return target;
}
export async function readRef(root, ref) {
  const path = await confined(root, ref.path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    check(before.isFile(), 'Referenced object must be a regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.nlink === after.nlink,
      'Referenced object changed during inspection');
    check(bytes.length === ref.bytes && sha256(bytes) === ref.sha256, 'Referenced bytes differ');
    return bytes;
  } finally { await handle.close(); }
}
export async function filesUnder(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    pathName(path);
    check(!entry.isSymbolicLink(), 'Symlinks are forbidden');
    if (entry.isDirectory()) result.push(...await filesUnder(root, path));
    else { check(entry.isFile(), 'Only regular files are supported'); result.push(path); }
  }
  return result.sort();
}

// The schema uses this deliberately small JSON Schema subset. Unsupported
// keywords fail when added, so a future schema cannot silently weaken checks.
export function validate(value, schema, definitions, location = '$') {
  const supported = new Set(['$schema', '$id', '$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'anyOf']);
  for (const key of Object.keys(schema)) check(supported.has(key), `Unsupported schema keyword ${key}`);
  if (schema.$ref) {
    check(schema.$ref.startsWith('#/$defs/'), 'External schema reference');
    const definition = definitions[schema.$ref.slice(8)];
    check(definition, 'Unknown schema reference');
    return validate(value, definition, definitions, location);
  }
  if (schema.anyOf) {
    check(schema.anyOf.some(option => { try { validate(value, option, definitions, location); return true; } catch { return false; } }), `Schema alternatives ${location}`);
    return;
  }
  if (schema.const !== undefined) check(same(value, schema.const), `Schema constant ${location}`);
  if (schema.enum) check(schema.enum.some(option => same(value, option)), `Schema enum ${location}`);
  if (schema.type === 'object') {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), `Expected object ${location}`);
    check(schema.additionalProperties === false, 'Objects must reject unknown fields');
    for (const key of schema.required ?? []) check(Object.hasOwn(value, key), `Missing field ${location}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      check(Object.hasOwn(schema.properties, key), `Unknown field ${location}.${key}`);
      validate(item, schema.properties[key], definitions, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    check(Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 4096), `Array bounds ${location}`);
    if (schema.uniqueItems) check(new Set(value.map(canonical)).size === value.length, `Duplicate array item ${location}`);
    value.forEach((item, index) => validate(item, schema.items, definitions, `${location}[${index}]`));
  } else if (schema.type === 'string') {
    check(typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? 4096), `Expected bounded string ${location}`);
    if (schema.pattern) check(new RegExp(schema.pattern).test(value), `String pattern ${location}`);
  } else if (schema.type === 'integer') {
    check(Number.isSafeInteger(value) && value >= (schema.minimum ?? 0) && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER), `Expected integer ${location}`);
  } else if (schema.type === 'null') check(value === null, `Expected null ${location}`);
  else if (schema.type === 'boolean') check(typeof value === 'boolean', `Expected boolean ${location}`);
}
