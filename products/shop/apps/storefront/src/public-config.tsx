import { createContext, useContext } from "react";
export const PublicConfigContext = createContext({ turnstileSiteKey: "" });
export function usePublicConfig() {
  return useContext(PublicConfigContext);
}
