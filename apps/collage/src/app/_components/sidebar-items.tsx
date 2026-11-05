"use client";
import React from "react";
import { SidebarMenuItem, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { Button } from "./ui/button";
import Link from "next/link";
import { Images, Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import SignInButtonWrapper from "./sign-in-button";

function SidebarItems({ userId }: { userId?: string }) {
  const { setOpenMobile } = useSidebar();
  const pathname = usePathname();

  return (
    <>
      <SidebarMenuItem>
        <Button variant={"outline"} asChild>
          <SidebarMenuButton asChild>
            <Link onClick={() => setOpenMobile(false)} href="/" prefetch={true}>
              Home
            </Link>
          </SidebarMenuButton>
        </Button>
      </SidebarMenuItem>
      {userId ? (
        <>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Button
                onClick={() => setOpenMobile(false)}
                variant={"outline"}
                asChild
              >
                <Link href={`/create`} prefetch={true}>
                  New Collage <Plus className="size-4" />
                </Link>
              </Button>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Button
                onClick={() => setOpenMobile(false)}
                variant={"outline"}
                asChild
              >
                <Link href={`/${userId}`} prefetch={true}>
                  My collages <Images className="size-4" />
                </Link>
              </Button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </>
      ) : pathname !== "/sign-in" ? (
        <SidebarMenuItem>
          <SignInButtonWrapper
            onClick={() => setOpenMobile(false)}
            variant={"outline"}
            asChild
          />
        </SidebarMenuItem>
      ) : null}
    </>
  );
}

export default SidebarItems;
