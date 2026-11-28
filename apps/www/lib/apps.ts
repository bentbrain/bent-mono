import type { StaticImageData } from "next/image";
import collageDesktop from "@/assets/screenshots/collage-desktop.webp";
import collageMobile from "@/assets/screenshots/collage-mobile.webp";
import driveDesktop from "@/assets/screenshots/drive-desktop.webp";
import driveMobile from "@/assets/screenshots/drive-mobile.webp";
import fitnessDesktop from "@/assets/screenshots/fitness-desktop.webp";
import fitnessMobile from "@/assets/screenshots/fitness-mobile.webp";
import homeDesktop from "@/assets/screenshots/home-desktop.webp";
import homeMobile from "@/assets/screenshots/home-mobile.webp";
import jpDesktop from "@/assets/screenshots/jp-desktop.webp";
import jpMobile from "@/assets/screenshots/jp-mobile.webp";
import shopDesktop from "@/assets/screenshots/shop-desktop.webp";
import shopMobile from "@/assets/screenshots/shop-mobile.webp";
import stayDesktop from "@/assets/screenshots/stay-desktop.webp";
import stayMobile from "@/assets/screenshots/stay-mobile.webp";
import toolbarDesktop from "@/assets/screenshots/toolbar-desktop.webp";
import toolbarMobile from "@/assets/screenshots/toolbar-mobile.webp";
import trackmapDesktop from "@/assets/screenshots/trackmap-desktop.webp";
import trackmapMobile from "@/assets/screenshots/trackmap-mobile.webp";

export type AppId =
  | "fitness"
  | "trackmap"
  | "shop"
  | "home"
  | "jp"
  | "stay"
  | "drive"
  | "toolbar"
  | "collage";

type Screenshot = Readonly<{ image: StaticImageData; alt: string }>;

type PhoneScreenshot = Screenshot &
  Readonly<{
    /** CSS background for the phone status bar, matching the screenshot's top edge. Defaults to white. */
    statusBar?: string;
  }>;

const sourceRoot = "https://github.com/bentbrain/bent-mono/tree/main";

export type ShowcaseApp = Readonly<{
  id: AppId;
  name: string;
  tagline: string;
  category: string;
  domain: string;
  access: string;
  description: string;
  highlights: readonly string[];
  /** Public source code location, for apps published in the bent-mono repository. */
  source?: string;
  desktop: Screenshot;
  mobile: PhoneScreenshot;
}>;

export const apps: readonly ShowcaseApp[] = [
  {
    id: "fitness",
    name: "Fitness",
    tagline: "Workout planner, food log and bodyweight tracker.",
    category: "Health & fitness",
    domain: "fitness.bent.build",
    access: "Invited accounts only",
    source: `${sourceRoot}/apps/fitness`,
    description:
      "Plan a week of dumbbell strength sessions, runs and rest days. Log each set with a rest timer, and record daily calories, protein and bodyweight.",
    highlights: [
      "Weekly schedule you can reorganise",
      "Setup, form cues, illustrations and a video for each included exercise",
      "Calorie and protein log with saved meals",
      "Strength history, bodyweight trend and data export",
      "Connects to AI assistants through MCP",
    ],
    desktop: {
      image: fitnessDesktop,
      alt: "Fitness week view on desktop with two completed sessions, today's Strength B workout, weekly totals and the exercise list.",
    },
    mobile: {
      image: fitnessMobile,
      alt: "Fitness week view on a phone with the seven-day schedule and today's Strength B workout.",
      statusBar: "#f4f6f8",
    },
  },
  {
    id: "trackmap",
    name: "Trackmap",
    tagline: "Turns a GPS activity file into a rotating 3D route.",
    category: "Sports",
    domain: "trackmap.bent.build",
    access: "Open to everyone",
    source: `${sourceRoot}/apps/trackmap`,
    description:
      "Open a GPX, TCX, FIT or GeoJSON file and Trackmap draws the route and its elevation in 3D. Export it as a video, image or GIF. Files stay in your browser.",
    highlights: [
      "Camera, colour, title, units and route trimming controls",
      "MP4 in 9:16 or 1:1 over a plain colour, photo or video",
      "PNG and looping GIF, with an optional transparent background",
      "Sample route included",
    ],
    desktop: {
      image: trackmapDesktop,
      alt: "Trackmap editor on desktop with the sample route preview, file upload and appearance controls.",
    },
    mobile: {
      image: trackmapMobile,
      alt: "Trackmap on a phone with the sample route card showing distance, elevation gain and elapsed time.",
    },
  },
  {
    id: "shop",
    name: "Shop",
    tagline: "T-shirts and totes printed with your photo.",
    category: "Shopping",
    domain: "shop.bent.build",
    access: "Open to everyone. Ships to Australia only.",
    description:
      "Buy a design from the shop, or make your own on a phone: take or upload a photo, adjust the background and effect, then order it on a t-shirt or tote.",
    highlights: [
      "Design editor on phones; desktop shows a QR code to continue on a phone",
      "Live t-shirt and tote previews",
      "Share a design by its link",
      "Change the delivery address or cancel from an email link for one hour after ordering",
    ],
    desktop: {
      image: shopDesktop,
      alt: "Shop product page on desktop with a black t-shirt printed with a photo of a person wearing the same shirt, colour and size options.",
    },
    mobile: {
      image: shopMobile,
      alt: "Shop product page on a phone with a black t-shirt printed with a photo of a person wearing the same shirt, colour and size options.",
    },
  },
  {
    id: "home",
    name: "Home",
    tagline: "3D model of an apartment with adjustable lighting.",
    category: "Lifestyle",
    domain: "home.bent.build",
    access: "Open to everyone",
    source: `${sourceRoot}/apps/home`,
    description:
      "An isometric 3D apartment with furniture, two cats and sunlight that follows the time of day. Turn the view in 90-degree steps and dim the lounge and bedroom lights. The lights are a simulation in your browser.",
    highlights: [
      "Four camera angles",
      "Lounge and bedroom brightness sliders",
      "Daylight based on the current time",
    ],
    desktop: {
      image: homeDesktop,
      alt: "Home on desktop with the isometric apartment, rotation arrows and lounge and bedroom light sliders.",
    },
    mobile: {
      image: homeMobile,
      alt: "Home on a phone with the isometric apartment, rotation arrows and lounge and bedroom light sliders.",
    },
  },
  {
    id: "jp",
    name: "Japan blog",
    tagline: "Travel blog from a trip to Japan.",
    category: "Travel",
    domain: "jp.bent.build",
    access: "Open to everyone",
    source: `${sourceRoot}/apps/jp`,
    description:
      "Posts with photos and videos, a gallery you can filter by category and a map of geotagged photos and videos in and around Japan. Subscribe by email to get new posts.",
    highlights: [
      "Map of geotagged photos and videos in and around Japan",
      "Gallery filtered by category",
      "Email updates for new posts",
    ],
    desktop: {
      image: jpDesktop,
      alt: "Japan blog on desktop with the email signup, a map of Japan with photo pins and three recent posts.",
    },
    mobile: {
      image: jpMobile,
      alt: "Japan blog on a phone with the email signup, the photo map and the latest post.",
    },
  },
  {
    id: "stay",
    name: "Stay",
    tagline: "Apartment guide for invited guests.",
    category: "Travel",
    domain: "stay.bent.build",
    access: "Invited guests only",
    source: `${sourceRoot}/apps/stay`,
    description:
      "Guests sign in to search the house guide and ask questions, which an AI assistant answers from the guide and appliance manuals. The guide also has the Wi-Fi details and controls for the lights, TV and robot vacuum that work on the apartment Wi-Fi.",
    highlights: [
      "Searchable house guide",
      "AI answers from the guide and appliance manuals",
      "Wi-Fi password and QR code",
      "Host editing and guest invitations",
    ],
    desktop: {
      image: stayDesktop,
      alt: "Stay guest guide on desktop with sample content, a search box, the Ask AI button and the home controls card.",
    },
    mobile: {
      image: stayMobile,
      alt: "Stay guest guide on a phone with sample content, a search box, the Ask AI button and the home controls card.",
    },
  },
  {
    id: "drive",
    name: "Drive",
    tagline: "Read-only Tesla status in ChatGPT.",
    category: "Utilities",
    domain: "drive.bent.build",
    access: "Invited GitHub accounts, plus a Tesla account",
    source: `${sourceRoot}/products/drive`,
    description:
      "An MCP server that lets ChatGPT read a Tesla's battery, range, charging, locks, climate and Sentry state. Sign in with an invited GitHub account, then approve read-only access with Tesla. The website has setup instructions.",
    highlights: [
      "Lists vehicles and reads their status",
      "Requests Tesla's read-only vehicle scope",
      "Your Tesla password stays with Tesla",
      "Tokens are encrypted and kept separate for each user",
    ],
    desktop: {
      image: driveDesktop,
      alt: "Drive website on desktop with an overview and the three connection steps.",
    },
    mobile: {
      image: driveMobile,
      alt: "Drive website on a phone with the overview.",
      statusBar:
        "linear-gradient(90deg, #1e0c0d, #280c0f 20%, #320d10 50%, #270b0e 80%, #200b0d)",
    },
  },
  {
    id: "toolbar",
    name: "Feedback toolbar",
    tagline: "Comment threads on website elements, with coding-agent requests.",
    category: "Developer tools",
    domain: "toolbar.bent.build",
    access: "Sign in with GitHub",
    source: `${sourceRoot}/apps/toolbar`,
    description:
      "Add a script tag to a website. Project members can then pin comment threads to page elements, reply and react, and send work requests to a coding agent on their own computer. The agent posts its results back to the thread.",
    highlights: [
      "Works with any web framework",
      "Runs in an iframe, separate from the site's styles",
      "Project members can use it on registered website origins",
      "Open source under the MIT license",
    ],
    desktop: {
      image: toolbarDesktop,
      alt: "Feedback toolbar on desktop over an example website, with a pinned heading and a comment thread showing Send to agent, Resolve and Reply.",
    },
    mobile: {
      image: toolbarMobile,
      alt: "Feedback toolbar on a phone over an example website, with a pinned heading and a comment thread.",
      statusBar: "#f8f7f3",
    },
  },
  {
    id: "collage",
    name: "Maya's Collages",
    tagline: "Collage editor and public feed.",
    category: "Art",
    domain: "maya-collage.bent.build",
    access: "Public feed. Sign in to make collages.",
    source: `${sourceRoot}/apps/collage`,
    description:
      "Browse the public feed, or sign in to make square collages in your browser from stickers and colour, gradient or image backgrounds. Keep collages private, publish them to the feed or download them.",
    highlights: [
      "Sticker categories, layers and undo",
      "Feed shows the newest collages first, with maker and date",
      "Profile pages for each maker",
    ],
    desktop: {
      image: collageDesktop,
      alt: "Maya's Collages feed on desktop with a sample collage, its maker and date, and a Sign in button.",
    },
    mobile: {
      image: collageMobile,
      alt: "Maya's Collages feed on a phone with sample collages.",
      statusBar: "#f5f5f5",
    },
  },
];
