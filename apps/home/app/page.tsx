import type { Metadata } from "next";
import { PublicApartment } from "./public-view/PublicApartment";

export const metadata: Metadata = {
  title: "Home",
  description:
    "A pixel apartment with Pearl and Maree.",
};

export default function Home() {
  return <PublicApartment />;
}
