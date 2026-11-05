import {readFileSync} from 'node:fs';
import type {Plugin} from 'vite';

// The viewer needs geometry and finishes, never purchase receipts or source-photo names.
export function publicMetadata(): Plugin {
  return {
    name: 'public-scene-metadata',
    enforce: 'pre',
    load(id) {
      if (!/\/data\/(furniture-audit|photo-objects|bedding)\.json$/.test(id)) return null;
      const data: unknown = JSON.parse(readFileSync(id, 'utf8'));
      if (!Array.isArray(data)) return null;
      const privateKeys = new Set(['source', 'photo', 'note', 'url', 'purchased', 'detail']);
      const clean = data.map((item: unknown) => typeof item === 'object' && item !== null
        ? Object.fromEntries(Object.entries(item).filter(([key]) => !privateKeys.has(key)))
        : item);
      return JSON.stringify(clean);
    },
    transform(code, id) {
      if (!id.endsWith('/app/editorState.ts')) return null;
      return code.replace(/source:'[^']*'/g, "source:'Scene model'");
    },
  };
}
