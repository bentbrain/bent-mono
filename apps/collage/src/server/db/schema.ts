// Example model schema from the Drizzle docs
// https://orm.drizzle.team/docs/sql-schema-declaration

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTableCreator,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * This is an example of how to use the multi-project schema feature of Drizzle ORM. Use the same
 * database instance for multiple projects.
 *
 * @see https://orm.drizzle.team/docs/goodies#multi-project-schema
 */
export const createTable = pgTableCreator(
  (name) => `drizzle_maya_collage_${name}`,
);

export const collages = createTable(
  "collage",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: varchar("user_id", { length: 256 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).$onUpdate(
      () => new Date(),
    ),
    collageJson: jsonb("collage_json").notNull(),
    imageUrl: varchar("image_url", { length: 256 }).notNull(),
    public: boolean("public").notNull().default(false),
    nsfw: boolean("nsfw").notNull().default(false),
  },
  (collage) => ({
    userIdIndex: index("user_id_idx").on(collage.userId),
    publicCreatedAtIndex: index("public_created_at_idx").on(
      collage.public,
      collage.createdAt,
    ),
    userIdCreatedAtIndex: index("user_id_created_at_idx").on(
      collage.userId,
      collage.createdAt,
    ),
  }),
);

export const userPreferences = createTable("user_preferences", {
  id: varchar("id", { length: 256 }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).$onUpdate(
    () => new Date(),
  ),
  showNsfw: boolean("show_nsfw").notNull().default(false),
  tutorialViewed: boolean("tutorial_viewed").notNull().default(false),
});
