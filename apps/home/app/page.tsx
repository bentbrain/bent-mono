import type { Metadata } from "next";
import { PublicApartment } from "./public-view/PublicApartment";

export const metadata: Metadata = {
  title: "Home",
  description:
    "Interactive isometric 3D apartment viewer with two animated cats and simulated lighting.",
};

export default function Home() {
  return <PublicApartment />;
}
