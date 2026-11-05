import type { Metadata } from "next";
import { ManageOrder } from "./manage-order";

export const metadata: Metadata = {
  title: "Manage order | bent.shop",
  description: "Correct your delivery address or cancel during the one-hour hold.",
  robots: {index: false, follow: false},
  referrer: "no-referrer",
};
export default function ManageOrderPage() {
  return <main className="ph-no-capture flex-1 px-5 pt-24 pb-12 text-primary sm:px-12"><div className="mx-auto max-w-xl"><h1 className="mb-8 text-3xl font-bold tracking-tight">Manage order</h1><ManageOrder /></div></main>;
}
