import type { GenericQueryCtx, GenericMutationCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";

type AuthContext = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

export async function requireUserId(ctx: AuthContext): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }
  return identity.subject;
}


export async function requireAdmin(ctx: AuthContext): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  if (identity.role !== "admin") throw new Error("Forbidden");
  return identity.subject;
}
