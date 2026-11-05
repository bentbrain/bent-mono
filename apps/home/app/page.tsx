import type { Metadata } from "next";
import { PublicApartment } from "./public-view/PublicApartment";

export const metadata: Metadata = {
  title: "Home",
  description:
    "A little home, with Pearl and Maree.",
};

export default function Home() {
  return <PublicApartment />;
}
