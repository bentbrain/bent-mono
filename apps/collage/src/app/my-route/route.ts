import { checkRole } from "@/utils/roles";
import configPromise from "@payload-config";
import { getPayload } from "payload";

export const GET = async () => {
  if (!(await checkRole("admin"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = await getPayload({
    config: configPromise,
  });

  const data = await payload.find({
    collection: "users",
  });

  return Response.json(data);
};
