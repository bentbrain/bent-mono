declare module "cloudflare:workers" {
  export const env: unknown;
}

declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV?: string;
  }
}
