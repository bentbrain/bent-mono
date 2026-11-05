/** Observe statement preparation while preserving the database's complete API. */
export function withDatabasePrepare(database: D1Database, prepare: D1Database["prepare"]): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return prepare;
      const value: unknown = Reflect.get(target, property, target);
      const forwarded: unknown = typeof value === "function" ? value.bind(target) : value;
      return forwarded;
    },
  });
}
