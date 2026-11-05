import typography from "@tailwindcss/typography";
import { type Config } from "tailwindcss";
import { fontFamily } from "tailwindcss/defaultTheme";
import tailwindcssAnimate from "tailwindcss-animate";
import plugin from "tailwindcss/plugin";

// UploadThing's public element/state variants, without withUt's dynamic
// require.resolve, which Turbopack expands into declaration-file imports.
const uploadthingPlugin = plugin((api) => {
  for (const element of ["button", "allowed-content", "label", "upload-icon", "clear-btn"]) {
    api.addVariant(`ut-${element}`, `&>*[data-ut-element="${element}"]`);
  }
  for (const state of ["readying", "ready", "uploading"]) {
    api.addVariant(`ut-${state}`, `&[data-state="${state}"]`);
  }
});

export default {
  darkMode: "class",
  content: [
    "./src/**/*.tsx",
    // Scan the installed UI implementation without bundling declaration files
    // through withUt's dynamic package-resolution expression.
    "../../node_modules/@uploadthing/react/dist/**/*.{js,cjs}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", ...fontFamily.sans],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
    },
  },
  plugins: [tailwindcssAnimate, typography, uploadthingPlugin],
} satisfies Config;
