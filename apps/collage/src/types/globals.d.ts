export {};

// Create a type for the roles
export type Roles = "admin" | "user";
export type UserMetadata = {
  role?: Roles;
};

declare global {
  interface CustomJwtSessionClaims {
    metadata: UserMetadata;
  }
}
