import type { CollectionConfig } from "payload";

export const Users: CollectionConfig = {
  slug: "users",
  admin: {
    useAsTitle: "email",
  },
  auth: {
    disableLocalStrategy: true,
    strategies: [
      {
        name: "clerk",
        authenticate: async ({ payload }) => {
          try {
            // Defer loading Clerk so Payload's standalone CLI can load this config.
            const { auth } = await import("@clerk/nextjs/server");
            const { userId } = await auth();

            if (!userId) {
              return { user: null };
            }

            // Determine if we're in development environment
            const isDev = process.env.NODE_ENV === "development";

            // Find the user in Payload using the appropriate field based on environment
            const { docs } = await payload.find({
              collection: "users",
              where: {
                [isDev ? "clerkIdDev" : "clerkId"]: {
                  equals: userId,
                },
              },
            });

            // If user found, return the user document
            if (docs[0]) {
              return {
                user: {
                  ...docs[0],
                  collection: "users",
                },
              };
            }

            // If no user found, return null user
            return { user: null };
          } catch (error) {
            console.error("Authentication error:", error);
            return { user: null };
          }
        },
      },
    ],
  },
  fields: [
    {
      name: "email",
      type: "text",
      admin: {
        readOnly: true,
      },
    },
    {
      name: "clerkId",
      type: "text",
      // required: true,
    },
    {
      name: "clerkIdDev",
      type: "text",
      // required: true,
    },
  ],
};
