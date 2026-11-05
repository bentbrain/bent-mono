import { nextjsConfig } from "@bent-build/eslint-config/nextjs";

export default nextjsConfig({
  clerkRoutes: {
    protected: ["src/app/admin/**", "src/app/oauth/authorize/**"],
    public: ["src/app/sign-in/**", "src/app/sign-up/**"],
  },
  rootDir: ".",
  tsconfigRootDir: import.meta.dirname,
});
