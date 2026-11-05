import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      domain: "https://clerk.maya-collage.bent.build",
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
