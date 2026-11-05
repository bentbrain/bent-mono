"use client";

import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { Tabs } from "@base-ui/react/tabs";
import { useQueryStates } from "nuqs";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { replaceMountedRoute } from "@/lib/navigation";
import { landingProductParsers } from "@/lib/product-params";

const subscribeToHydration = () => () => { /* React checks the client snapshot after hydration. */ };
const clientHydrated = () => true;
const serverHydrated = () => false;

export function useProductControlsReady() {
  return useSyncExternalStore(subscribeToHydration, clientHydrated, serverHydrated);
}

const ProductPanelActiveContext = createContext(true);
const ProductMediaWarmupContext = createContext({ warm: true, imageReady: () => { /* Standalone media has no siblings to warm. */ } });

export function useProductMediaWarmup() {
  return useContext(ProductMediaWarmupContext);
}

export function useProductPanelActive() {
  return useContext(ProductPanelActiveContext);
}

export interface ProductFamilyEntry {
  readonly baseProductSlug: BaseProductSlug;
  readonly href: string;
  readonly panel: ReactNode;
  readonly panelId: string;
}

export function ProductFamily({
  entries,
  familyQueryParamName,
  initialPanelId,
  syncUrl = true,
}: {
  entries: readonly ProductFamilyEntry[];
  familyQueryParamName?: string;
  initialPanelId: string;
  syncUrl?: boolean;
}) {
  if (familyQueryParamName === "product") {
    return (
      <LandingProductFamily
        entries={entries}
        initialPanelId={initialPanelId}
        syncUrl={syncUrl}
      />
    );
  }

  return (
    <ProductFamilyTabs
      entries={entries}
      initialPanelId={initialPanelId}
      onPanelChange={(entry) => {
        if (syncUrl) replaceMountedRoute(entry.href);
      }}
    />
  );
}

function LandingProductFamily({
  entries,
  initialPanelId,
  syncUrl,
}: {
  entries: readonly ProductFamilyEntry[];
  initialPanelId: string;
  syncUrl: boolean;
}) {
  const [, setLandingProductParams] = useQueryStates(landingProductParsers, {
    clearOnDefault: false,
    history: "replace",
    scroll: false,
    shallow: true,
  });

  return (
    <ProductFamilyTabs
      entries={entries}
      initialPanelId={initialPanelId}
      onPanelChange={(entry) => {
        if (!syncUrl) return;
        void setLandingProductParams({
          product: entry.baseProductSlug === "staple-tee" ? "shirt" : "tote",
        });
      }}
    />
  );
}

function ProductFamilyTabs({
  entries,
  initialPanelId,
  onPanelChange,
}: {
  entries: readonly ProductFamilyEntry[];
  initialPanelId: string;
  onPanelChange: (entry: ProductFamilyEntry) => void;
}) {
  // A visible server-rendered tab must not silently discard a click before hydration.
  const hydrated = useProductControlsReady();
  const [activePanelId, setActivePanelId] = useState(initialPanelId);
  const [loaded, setLoaded] = useState(false);
  const [warm, setWarm] = useState(false);
  const imageReady = useCallback(() => { setLoaded(true); }, []);
  useEffect(() => {
    if (!loaded) return;
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(() => { setWarm(true); }, { timeout: 1500 });
      return () => { window.cancelIdleCallback(idle); };
    }
    const timer = window.setTimeout(() => { setWarm(true); }, 200);
    return () => { window.clearTimeout(timer); };
  }, [loaded]);
  const orderedEntries = entries.toSorted(
    (left, right) => productOrder(left.baseProductSlug) - productOrder(right.baseProductSlug),
  );

  return (
    <ProductMediaWarmupContext value={{ warm, imageReady }}>
      <Tabs.Root
        aria-label="Products"
        className="relative min-[901px]:[&_[data-product-commerce]]:pt-14"
        value={activePanelId}
        onValueChange={(panelId) => {
          const entry = orderedEntries.find(
            (candidate) => candidate.panelId === panelId,
          );
          if (!entry) return;
          setActivePanelId(entry.panelId);
          onPanelChange(entry);
        }}
      >
        <div className="mx-auto flex min-h-14 max-w-[1400px] items-center min-[901px]:pointer-events-none min-[901px]:absolute min-[901px]:inset-x-0 min-[901px]:top-0 min-[901px]:z-20 min-[901px]:grid min-[901px]:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)] min-[901px]:gap-[clamp(2rem,5vw,6rem)]">
          <Tabs.List
            activateOnFocus
            aria-label="Product"
            className="flex w-fit items-center gap-2 min-[901px]:pointer-events-auto min-[901px]:col-start-2 min-[901px]:pl-3"
          >
            {orderedEntries.map((entry) => {
              return (
                <ProductTab
                  disabled={!hydrated}
                  entry={entry}
                  key={entry.panelId}
                />
              );
            })}
          </Tabs.List>
        </div>

        {orderedEntries.map((entry) => (
          <Tabs.Panel
            className="max-[900px]:border-t border-primary"
            id={productPanelId(entry.baseProductSlug)}
            key={entry.panelId}
            keepMounted
            value={entry.panelId}
          >
            <ProductPanelActiveContext value={entry.panelId === activePanelId}>
              {entry.panel}
            </ProductPanelActiveContext>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </ProductMediaWarmupContext>
  );
}

function productOrder(slug: BaseProductSlug) {
  return slug === "staple-tee" ? 0 : 1;
}

function ProductTab({
  disabled,
  entry,
}: {
  disabled: boolean;
  entry: ProductFamilyEntry;
}) {
  return (
    <Tabs.Tab
      disabled={disabled}
      className="grid h-11 min-w-24 place-items-center border-0 px-4 font-mono text-xs font-bold tracking-[0.06em] outline-none data-[active]:border data-[active]:border-dotted data-[active]:border-primary data-[disabled]:opacity-50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      id={productTabId(entry.baseProductSlug)}
      value={entry.panelId}
    >
      {productLabel(entry.baseProductSlug)}
    </Tabs.Tab>
  );
}

function productTabId(slug: BaseProductSlug) {
  return `configured-product-tab-${slug}`;
}

function productPanelId(slug: BaseProductSlug) {
  return `configured-product-panel-${slug}`;
}

function productLabel(slug: BaseProductSlug) {
  return slug === "staple-tee" ? "t-shirt" : "tote";
}
