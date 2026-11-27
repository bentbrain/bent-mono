import { createContext, useContext } from "react";
import type { Settings } from "@bent/fitness-contracts/domain";
import type { Sync } from "../sync";
export const AccountContext = createContext<
  | {
      sync: Sync;
      settings: Settings;
      date: string;
      today: string;
      owner: string;
      setInputPending: (pending: boolean) => void;
    }
  | undefined
>(undefined);
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account)
    throw new Error("Open this screen from your signed-in account.");
  return account;
}
