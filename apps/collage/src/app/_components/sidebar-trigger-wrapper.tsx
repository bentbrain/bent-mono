import { auth } from "@clerk/nextjs/server";
import React from "react";
import { SidebarTrigger } from "./ui/sidebar";

async function SidbarTriggerWrapper() {
  const { userId } = await auth();
  return (
    <div className="flex w-full justify-start">
      {userId && (
        <SidebarTrigger variant={"outline"} className="border sm:hidden" />
      )}
    </div>
  );
}

export default SidbarTriggerWrapper;
