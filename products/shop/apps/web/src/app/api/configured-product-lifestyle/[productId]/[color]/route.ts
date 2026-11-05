import { storedProductImageResponse } from "@/server/product-image-bff";

async function image(request:Request, context:{params:Promise<{productId:string;color:string}>}) {
  return storedProductImageResponse({...await context.params,view:"lifestyle",method:request.method});
}
export const GET=image;
export const HEAD=image;
