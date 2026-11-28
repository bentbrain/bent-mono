import { rotateAroundOrigin } from "@apartment-hotel/scene-engine";
import type { Item, Product } from "./editorState";
import type { Rect } from "./plan";
export interface Surface extends Rect {
  id: string;
  owner: string;
  height: number;
  use: "seat" | "top";
  clearance?: number;
  round?: boolean;
}
export const FIXED_SURFACES: readonly Surface[] = [
  {
    id: "counter-work",
    owner: "dishwasher",
    x: 0.1,
    z: 3.93,
    w: 0.5,
    d: 0.54,
    height: 0.91,
    use: "top",
  },
  {
    id: "counter-end",
    owner: "bench",
    x: 0.1,
    z: 5.13,
    w: 0.5,
    d: 0.54,
    height: 0.91,
    use: "top",
  },
  {
    id: "counter-drainer",
    owner: "sink",
    x: 0.1,
    z: 2.73,
    w: 0.5,
    d: 0.23,
    height: 0.914,
    use: "top",
  },
  {
    id: "upper-top",
    owner: "overheads",
    x: 0.08,
    z: 3.23,
    w: 0.28,
    d: 2.44,
    height: 2.3,
    use: "top",
  },
  {
    id: "toilet-seat",
    owner: "toilet",
    x: 7.45,
    z: 4.98,
    w: 0.32,
    d: 0.34,
    height: 0.512,
    use: "seat",
  },
  {
    id: "robe-top",
    owner: "robe",
    x: 4.85,
    z: 0.06,
    w: 0.49,
    d: 2.52,
    height: 2.4,
    use: "top",
  },
];
function transformRect(r: Rect, item: Item): Rect {
  const corners = [
    { x: r.x, z: r.z },
    { x: r.x + r.w, z: r.z },
    { x: r.x, z: r.z + r.d },
    { x: r.x + r.w, z: r.z + r.d },
  ].map((p) => rotateAroundOrigin(p, item.rotation));
  const xs = corners.map((p) => p.x + item.x),
    zs = corners.map((p) => p.z + item.z);
  return {
    x: Math.min(...xs),
    z: Math.min(...zs),
    w: Math.max(...xs) - Math.min(...xs),
    d: Math.max(...zs) - Math.min(...zs),
  };
}

/** The same support surfaces can be used for placing small objects in a 3D editor. */
export function furnitureSurfaces(item: Item, p: Product): Surface[] {
  if (p.baseModel) {
    const { baseModel, ...base } = p;
    return furnitureSurfaces({ ...item, productId: baseModel }, base);
  }
  const surfaces: Surface[] = [];

  {
    if (p.supportHeight === undefined) return [];
    let r: Rect = {
        x: -p.w / 2 + 0.03,
        z: -p.d / 2 + 0.03,
        w: p.w - 0.06,
        d: p.d - 0.06,
      },
      height = p.supportHeight,
      use: Surface["use"] = "top";
    if (item.productId === "dyvlinge") {
      r = { x: -0.22, z: -0.11, w: 0.44, d: 0.39 };
      height = 0.43;
      use = "seat";
    }
    if (item.productId === "sofa") {
      r = { x: -0.79, z: -0.2, w: 1.58, d: 0.56 };
      height = 0.59;
      use = "seat";
    }
    if (item.productId === "kirribilli") {
      r = { x: -0.71, z: -0.86, w: 1.42, d: 1.84 };
      height = 0.64;
      use = "seat";
    }
    if (item.productId === "perjohan") {
      r = { x: -0.46, z: -0.115, w: 0.92, d: 0.23 };
      height = 0.45;
      use = "seat";
    }
    if (item.productId === "fireside") {
      r = { x: -0.83, z: -0.04, w: 1.66, d: 0.39 };
      height = 0.36;
      use = "seat";
    }
    if (item.productId === "casalino") {
      r = { x: -0.22, z: -0.12, w: 0.44, d: 0.33 };
      height = item.seatPad ? 0.46 : 0.436;
      use = "seat";
    }
    if (item.productId === "numero-high" || item.productId === "numero-low") {
      r = { x: -0.29, z: -0.02, w: 0.58, d: 0.32 };
      height = 0.33;
      use = "seat";
    }
    if (item.productId === "byakorre") {
      for (const [index, level] of [0.3, 0.66, 1.025, 1.39].entries())
        surfaces.push({
          ...transformRect(r, item),
          id: `${item.id}-shelf-${index}`,
          owner: item.id,
          height: (item.elevation ?? p.defaultElevation ?? 0) + level,
          use: "top",
          ...(index < 3 ? { clearance: 0.335 } : {}),
        });
    } else
      surfaces.push({
        ...transformRect(r, item),
        id: `${item.id}-support`,
        owner: item.id,
        round: p.supportShape === "round",
        height: (item.elevation ?? p.defaultElevation ?? 0) + height,
        use,
      });
  }
  return surfaces;
}

export function fitsSupport(item: Item, p: Product, s: Surface): boolean {
  const w = item.rotation % 2 ? (p.baseD ?? p.d) : (p.baseW ?? p.w),
    d = item.rotation % 2 ? (p.baseW ?? p.w) : (p.baseD ?? p.d);
  if (p.h > (s.clearance ?? Infinity) + 0.001) return false;
  if (s.round && p.contactShape === "round")
    return (
      Math.hypot(item.x - s.x - s.w / 2, item.z - s.z - s.d / 2) +
        Math.max(w, d) / 2 <=
      Math.min(s.w, s.d) / 2 + 0.001
    );
  for (const x of [item.x - w / 2, item.x + w / 2])
    for (const z of [item.z - d / 2, item.z + d / 2]) {
      if (s.round) {
        if (
          ((x - s.x - s.w / 2) / (s.w / 2)) ** 2 +
            ((z - s.z - s.d / 2) / (s.d / 2)) ** 2 >
          1.002
        )
          return false;
      } else if (
        x < s.x - 0.001 ||
        x > s.x + s.w + 0.001 ||
        z < s.z - 0.001 ||
        z > s.z + s.d + 0.001
      )
        return false;
    }
  return true;
}
