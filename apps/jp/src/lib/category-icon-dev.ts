import type { D1Database } from '@cloudflare/workers-types';
import migration from '../../migrations/0001_category_icons.sql?raw';
import libraryMigration from '../../migrations/0002_icon_library.sql?raw';
const databases = new WeakMap<D1Database, Promise<unknown>>();
export async function ensureLocalIconSchema(db: D1Database) {
  let pending = databases.get(db);
  if (!pending) {
    pending = db.batch(
      `${migration}\n--> statement-breakpoint\n${libraryMigration}`
        .split('--> statement-breakpoint')
        .map((statement) => statement.replace(/^--.*$/gm, '').trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement)),
    );
    databases.set(db, pending);
  }
  await pending;
}
