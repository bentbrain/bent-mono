import { database } from "../src/server/db";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL)
  throw new Error("Set the dedicated fitness database URL.");
const sql = database();
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
  });
  console.log("Fitness schema ready.");
} finally {
  await sql.end();
}
