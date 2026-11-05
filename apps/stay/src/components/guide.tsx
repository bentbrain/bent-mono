"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import Fuse from "fuse.js";
import { richText } from "@/lib/rich-text";
import { localHomeControlsUrl } from "@/lib/home-control-link";
import { ArrowUpRight, House, MessageCircle, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArticleContent } from "@/components/article-content";
import { Input } from "@/components/ui/input";
import { WifiSetup } from "@/components/wifi-access";
import { wifiStateSchema } from "@/lib/wifi-types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { GuideArticle, GuideCategory, GuideHome } from "@/lib/guide-types";

const GuestChat = dynamic(
  () => import("@/components/guest-chat").then((module) => module.GuestChat),
  { loading: () => <p className="p-5 text-sm">loading…</p> },
);
const categories: { category: GuideCategory; label: string }[] = [
  { category: "At home", label: "in the apartment" },
  { category: "Arrival", label: "getting here" },
  { category: "The building", label: "around the building" },
  { category: "Help", label: "help" },
];

function panelHistoryDepth() {
  const state: unknown = window.history.state;
  if (
    state !== null &&
    typeof state === "object" &&
    "guidePanelDepth" in state &&
    typeof state.guidePanelDepth === "number" &&
    Number.isSafeInteger(state.guidePanelDepth) &&
    state.guidePanelDepth > 0
  )
    return state.guidePanelDepth;
  return 0;
}

export function Guide({
  articles,
  home,
  isHost,
  setupTopics,
}: {
  articles: GuideArticle[];
  home: GuideHome;
  isHost: boolean;
  setupTopics: string[];
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | undefined>();
  const chatOpen = selected === "chat";
  const setupOpen = selected === "setup";
  const [wifiPassword, setWifiPassword] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const availableArticles = useMemo(
    () =>
      articles.filter(
        (item) => item.id !== "wifi" || wifiPassword !== null || isHost,
      ),
    [articles, wifiPassword, isHost],
  );
  const index = useMemo(
    () =>
      new Fuse(
        availableArticles.map((item) => ({
          ...item,
          searchText: richText(item.body),
        })),
        {
          keys: [
            { name: "title", weight: 3 },
            { name: "keywords", weight: 2 },
            "summary",
            "searchText",
            "paragraphs",
            "steps",
            "sections.title",
            "sections.description",
            "sections.items.label",
            "sections.items.location",
          ],
          threshold: 0.35,
          ignoreLocation: true,
        },
      ),
    [availableArticles],
  );
  const searching = Boolean(query.trim());
  const results = searching
    ? index.search(query.trim()).map((result) => result.item)
    : availableArticles;
  const sections = searching
    ? [{ label: "search results", articles: results }]
    : categories.map(({ category, label }) => ({
        label,
        articles: availableArticles.filter(
          (article) => article.category === category,
        ),
      }));
  const article = articles.find((item) => item.id === selected);
  const pendingTopics =
    wifiPassword === null ? ["Wi-Fi password", ...setupTopics] : setupTopics;

  useEffect(() => {
    const controller = new AbortController();
    async function loadWifi() {
      try {
        const response = await fetch("/api/wifi", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) return;
        const data: unknown = await response.json();
        const parsed = wifiStateSchema.safeParse(data);
        if (parsed.success) setWifiPassword(parsed.data.password);
      } catch {
        // Keep an unfinished or unavailable Wi-Fi topic out of guest navigation.
      }
    }
    void loadWifi();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function fromHash() {
      const hash = ["#washing-machine", "#dryer"].includes(window.location.hash)
        ? "#laundry"
        : window.location.hash;
      const item = availableArticles.find((item) => `#${item.id}` === hash);
      setSelected(
        item?.id ??
          (hash === "#chat"
            ? "chat"
            : hash === "#setup" && isHost
              ? "setup"
              : undefined),
      );
    }
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("popstate", fromHash);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("popstate", fromHash);
      window.removeEventListener("keydown", shortcut);
    };
  }, [availableArticles, isHost]);
  function openPanel(id: string) {
    if (window.location.hash !== `#${id}`) {
      window.history.pushState(
        { guidePanelDepth: panelHistoryDepth() + 1 },
        "",
        window.location.pathname + window.location.search + `#${id}`,
      );
    }
    setSelected(id);
  }
  function openArticle(id: string) {
    if (!availableArticles.some((item) => item.id === id)) return false;
    openPanel(id);
    return true;
  }
  function closePanel() {
    if (panelHistoryDepth() > 0) {
      window.history.back();
      return;
    }
    setSelected(undefined);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  function goHome() {
    const depth = panelHistoryDepth();
    if (depth > 0) window.history.go(-depth);
    else closePanel();
  }
  return (
    <div className="min-h-dvh">
      <header className="site-header">
        <Link
          href="/"
          className="brand-link"
          aria-label="bent.stay home"
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            goHome();
          }}
        >
          <House size={16} strokeWidth={1.5} />
          bent.stay
        </Link>
        <div className="flex items-center gap-4">
          {isHost && (
            <>
              <Link href="/edit" className="text-xs hover:underline">
                edit guide
              </Link>
              <Link href="/guests" className="text-xs hover:underline">
                guests
              </Link>
            </>
          )}
          <UserButton />
        </div>
      </header>
      <main className="page-shell guide-shell">
        <div className="mb-6">
          <div>
            <h1 className="text-lg font-medium sm:text-xl">{home.name}</h1>
            <p className="mt-1 text-xs leading-6">{home.address}</p>
          </div>
          <p className="mt-2 text-xs leading-6">
            {home.host}: {home.hostPhone} · {home.hostEmail}
          </p>
          {home.intro && (
            <p
              className="mt-4 whitespace-pre-line text-sm leading-7"
              data-guide-intro
            >
              {home.intro}
            </p>
          )}
        </div>
        <div className="search-row">
          <div className="search-box">
            <Search size={18} className="shrink-0" />
            <Input
              ref={inputRef}
              id="guide-search"
              type="search"
              placeholder="find an answer"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the guide"
              className="h-12 border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
            />
            <kbd className="hidden shrink-0 whitespace-nowrap text-xs sm:block">
              ⌘ K
            </kbd>
          </div>
          <Button
            className="min-h-12 px-3"
            aria-label="Ask the guide"
            onClick={() => openPanel("chat")}
          >
            <MessageCircle size={16} />
            ask AI
          </Button>
        </div>
        <section
          hidden={searching}
          className="mb-8 border p-4 sm:p-5"
          aria-label="Home controls"
        >
          <h2 className="text-sm font-medium">home controls</h2>
          <p className="mt-2 text-xs leading-6">
            control the lights, TV and robot vacuum. connect to the apartment
            wi-fi ({home.wifiNetwork}) first; the controls only work on the home
            network.
          </p>
          <a
            href={localHomeControlsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex min-h-11 items-center gap-2 border px-3 text-xs uppercase hover:bg-primary hover:text-primary-foreground"
          >
            open home controls <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </section>
        <p className="sr-only" aria-live="polite">
          {results.length} topics
        </p>
        <div className="space-y-7">
          {sections
            .filter((section) => section.articles.length > 0)
            .map((section) => (
              <section key={section.label} aria-label={section.label}>
                <h2 className="mb-3 text-sm font-medium">{section.label}</h2>
                <div className="grid grid-cols-2 gap-2">
                  {section.articles.map((item) => (
                    <button
                      key={item.id}
                      className="task-button"
                      data-guide-topic={item.id}
                      aria-haspopup="dialog"
                      onClick={() => openArticle(item.id)}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span>{item.title}</span>
                        <ArrowUpRight size={15} className="shrink-0" />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          {results.length === 0 && (
            <p className="py-4 text-sm">
              no matches. try another word or ask AI.
            </p>
          )}
        </div>
        <footer className="site-footer">
          <span>
            {home.name}, {home.neighbourhood}
          </span>
          {isHost && (
            <button
              className="min-h-11 text-xs"
              onClick={() => openPanel("setup")}
            >
              setup
              {pendingTopics.length > 0 ? ` · ${pendingTopics.length}` : ""}
            </button>
          )}
        </footer>
      </main>
      <Sheet
        open={Boolean(article)}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
      >
        <SheetContent
          showCloseButton={false}
          className="flex h-dvh flex-col gap-0"
          style={{ width: "min(100%, 36rem)", maxWidth: "none" }}
        >
          <SheetHeader className="flex-row items-start justify-between gap-4 border-b p-5">
            <div>
              <SheetTitle className="text-lg font-medium">
                {article?.title}
              </SheetTitle>
              <SheetDescription className="sr-only">
                {article?.summary}
              </SheetDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close instructions"
              onClick={closePanel}
            >
              <X size={20} />
            </Button>
          </SheetHeader>
          {article && (
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 text-sm leading-7">
              <ArticleContent
                article={article}
                wifiPassword={wifiPassword}
                wifiNetwork={home.wifiNetwork}
              />
              {article.id === "wifi" && isHost && wifiPassword === null && (
                <WifiSetup
                  network={home.wifiNetwork}
                  configured={false}
                  onSaved={setWifiPassword}
                />
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={chatOpen}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
      >
        <SheetContent
          showCloseButton={false}
          className="flex h-dvh flex-col gap-0"
          style={{ width: "min(100%, 32rem)", maxWidth: "none" }}
        >
          <SheetHeader className="flex-row items-center justify-between border-b px-5 py-4">
            <SheetTitle className="text-base font-medium">ask AI</SheetTitle>
            <SheetDescription className="sr-only">
              Ask a question about the apartment.
            </SheetDescription>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close chat"
              onClick={closePanel}
            >
              <X size={20} />
            </Button>
          </SheetHeader>
          {chatOpen && <GuestChat onArticleOpen={openArticle} />}
        </SheetContent>
      </Sheet>
      {isHost && (
        <Sheet
          open={setupOpen}
          onOpenChange={(open) => {
            if (!open) closePanel();
          }}
        >
          <SheetContent style={{ width: "min(100%, 28rem)", maxWidth: "none" }}>
            <SheetHeader>
              <SheetTitle>setup</SheetTitle>
              <SheetDescription>host only</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 overflow-y-auto p-4 text-sm leading-7">
              <WifiSetup
                network={home.wifiNetwork}
                configured={wifiPassword !== null}
                onSaved={setWifiPassword}
              />
              {pendingTopics.length > 0 ? (
                <>
                  <p className="mb-4">details to confirm before publishing:</p>
                  <ul className="list-disc space-y-2 pl-5">
                    {pendingTopics.map((title) => (
                      <li key={title}>{title}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>all topics are published.</p>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
