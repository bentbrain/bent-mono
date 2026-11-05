import { type Config } from "drizzle-kit";

import { env } from "@/env";

export default {
  schema: "./src/server/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URI,
  },
  tablesFilter: ["drizzle_maya_collage_*"],
} satisfies Config;
