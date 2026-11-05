import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@/app/_components/ui/sidebar";
import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";
import SidebarItems from "./sidebar-items";
export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarContent className="py-4">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              <Suspense fallback={null}>
                <DynamicSidebarItems />
              </Suspense>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}

async function DynamicSidebarItems() {
  const { userId } = await auth();
  return <SidebarItems userId={userId ?? undefined} />;
}
