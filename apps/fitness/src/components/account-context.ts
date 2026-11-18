import { createContext, useContext } from "react";
import type { Settings } from "../domain";
import type { Sync } from "../sync";
export const AccountContext = createContext<
  | {
      sync: Sync;
      settings: Settings;
      date: string;
    }
  | undefined
>(undefined);
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account)
    throw new Error("Open this screen from your signed-in account.");
  return account;
}
