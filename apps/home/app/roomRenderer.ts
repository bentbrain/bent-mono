import {
  type CameraQuarter,
  projectWorldPoint,
  rotateAroundOrigin,
} from "@apartment-hotel/scene-engine";
import {
  PLAN_CENTER,
  type CompiledWallSegment,
  type FloorCell,
  type FloorMaterial,
  type PlanPoint,
  apartmentFloorCells,
  compileWallRuns,
  floorMaterialAt,
} from "./apartmentPlan";

export const LOGICAL_WIDTH = 640;
export const LOGICAL_HEIGHT = 400;

const TILE_WIDTH = 32;
const TILE_HEIGHT = 16;
const FLOOR_EDGE_HEIGHT = 8;

const palette = {
  background: "#86d4e8",
  outline: "#251d2f",
  outlineSoft: "#4a3857",
  wallLight: "#fffef3",
  wallMid: "#fff5d6",
  wallShade: "#ead39d",
  oakLight: "#e4a46d",
  oakMid: "#d6a36b",
  oakDark: "#8f5b45",
  tileLight: "#fff5d6",
  tileMid: "#ead39d",
  tileDark: "#8f5b45",
  glassLight: "#86d4e8",
  glassMid: "#52c7bd",
  glassDark: "#277f7e",
};

interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

interface BoundaryEdge {
  readonly start: PlanPoint;
  readonly end: PlanPoint;
  readonly normal: PlanPoint;
  readonly material: FloorMaterial;
}

const projection = {
  tileWidth: TILE_WIDTH,
  tileHeight: TILE_HEIGHT,
  origin: { x: LOGICAL_WIDTH / 2, y: 198 },
};

function centeredPlanPoint(point: PlanPoint): PlanPoint {
  return {
    x: point.x - PLAN_CENTER.x,
    z: point.z - PLAN_CENTER.z,
  };
}

function projectPlanPoint(
  point: PlanPoint,
  cameraQuarter: CameraQuarter,
): PixelPoint {
  return projectWorldPoint(
    centeredPlanPoint(point),
    cameraQuarter,
    projection,
  );
}

export function drawPixelLine(
  context: CanvasRenderingContext2D,
  start: PixelPoint,
  end: PixelPoint,
  color: string,
  width: number = 1,
): void {
  let x = Math.round(start.x);
  let y = Math.round(start.y);
  const targetX = Math.round(end.x);
  const targetY = Math.round(end.y);
  const deltaX = Math.abs(targetX - x);
  const stepX = x < targetX ? 1 : -1;
  const deltaY = -Math.abs(targetY - y);
  const stepY = y < targetY ? 1 : -1;
  let error = deltaX + deltaY;

  context.fillStyle = color;
  while (true) {
    context.fillRect(x, y, width, width);
    if (x === targetX && y === targetY) {
      break;
    }
    const doubledError = error * 2;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

export function fillPixelPolygon(
  context: CanvasRenderingContext2D,
  points: readonly PixelPoint[],
  color: string,
): void {
  const yValues = points.map((point) => Math.round(point.y));
  const minimumY = Math.min(...yValues);
  const maximumY = Math.max(...yValues);
  context.fillStyle = color;

  for (let y = minimumY; y <= maximumY; y += 1) {
    const scanY = y + 0.5;
    const intersections: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      if (current === undefined || next === undefined) {
        continue;
      }
      const crosses =
        (current.y <= scanY && next.y > scanY) ||
        (next.y <= scanY && current.y > scanY);
      if (!crosses) {
        continue;
      }
      const progress = (scanY - current.y) / (next.y - current.y);
      intersections.push(current.x + (next.x - current.x) * progress);
    }
    intersections.sort((left, right) => left - right);
    for (let index = 0; index < intersections.length; index += 2) {
      const left = intersections[index];
      const right = intersections[index + 1];
      if (left === undefined || right === undefined) {
        continue;
      }
      const startX = Math.ceil(left);
      const endX = Math.floor(right);
      if (endX >= startX) {
        context.fillRect(startX, y, endX - startX + 1, 1);
      }
    }
  }
}

export function drawPixelPolygonOutline(
  context: CanvasRenderingContext2D,
  points: readonly PixelPoint[],
  color: string,
): void {
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current !== undefined && next !== undefined) {
      drawPixelLine(context, current, next, color);
    }
  }
}

function floorDiamond(
  cell: FloorCell,
  cameraQuarter: CameraQuarter,
): readonly PixelPoint[] {
  const center = projectPlanPoint(
    { x: cell.x, z: cell.z },
    cameraQuarter,
  );
  return [
    { x: center.x, y: center.y - TILE_HEIGHT / 2 },
    { x: center.x + TILE_WIDTH / 2, y: center.y },
    { x: center.x, y: center.y + TILE_HEIGHT / 2 },
    { x: center.x - TILE_WIDTH / 2, y: center.y },
  ];
}

function floorFill(cell: FloorCell): string {
  if (cell.material === "oak") {
    return cell.z % 4 === 0 && cell.x % 3 === 0
      ? palette.oakLight
      : palette.oakMid;
  }
  if (cell.material === "balcony-tile") {
    return (cell.x + cell.z) % 2 === 0
      ? palette.tileLight
      : palette.tileMid;
  }
  return (cell.x + cell.z) % 2 === 0
    ? palette.wallLight
    : palette.tileMid;
}

function floorOutline(material: FloorMaterial): string {
  return material === "oak" ? palette.oakDark : palette.tileDark;
}

function drawFloorCell(
  context: CanvasRenderingContext2D,
  cell: FloorCell,
  cameraQuarter: CameraQuarter,
): void {
  const points = floorDiamond(cell, cameraQuarter);
  fillPixelPolygon(context, points, floorFill(cell));
  drawPixelPolygonOutline(context, points, floorOutline(cell.material));

  if (cell.material === "oak" && (cell.x + cell.z) % 2 === 0) {
    const center = projectPlanPoint(
      { x: cell.x, z: cell.z },
      cameraQuarter,
    );
    drawPixelLine(
      context,
      { x: center.x - 8, y: center.y },
      { x: center.x, y: center.y + 4 },
      palette.oakLight,
    );
  }
}

function boundaryEdges(): readonly BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  for (const cell of apartmentFloorCells()) {
    if (floorMaterialAt(cell.x, cell.z - 1) === undefined) {
      edges.push({
        start: { x: cell.x - 0.5, z: cell.z - 0.5 },
        end: { x: cell.x + 0.5, z: cell.z - 0.5 },
        normal: { x: 0, z: -1 },
        material: cell.material,
      });
    }
    if (floorMaterialAt(cell.x + 1, cell.z) === undefined) {
      edges.push({
        start: { x: cell.x + 0.5, z: cell.z - 0.5 },
        end: { x: cell.x + 0.5, z: cell.z + 0.5 },
        normal: { x: 1, z: 0 },
        material: cell.material,
      });
    }
    if (floorMaterialAt(cell.x, cell.z + 1) === undefined) {
      edges.push({
        start: { x: cell.x + 0.5, z: cell.z + 0.5 },
        end: { x: cell.x - 0.5, z: cell.z + 0.5 },
        normal: { x: 0, z: 1 },
        material: cell.material,
      });
    }
    if (floorMaterialAt(cell.x - 1, cell.z) === undefined) {
      edges.push({
        start: { x: cell.x - 0.5, z: cell.z + 0.5 },
        end: { x: cell.x - 0.5, z: cell.z - 0.5 },
        normal: { x: -1, z: 0 },
        material: cell.material,
      });
    }
  }
  return edges;
}

function rotatedNormal(
  edge: BoundaryEdge,
  cameraQuarter: CameraQuarter,
): PlanPoint {
  return rotateAroundOrigin(edge.normal, cameraQuarter);
}

function isFrontEdge(
  edge: BoundaryEdge,
  cameraQuarter: CameraQuarter,
): boolean {
  const normal = rotatedNormal(edge, cameraQuarter);
  return normal.x > 0 || normal.z > 0;
}

function drawFloorEdge(
  context: CanvasRenderingContext2D,
  edge: BoundaryEdge,
  cameraQuarter: CameraQuarter,
): void {
  const start = projectPlanPoint(edge.start, cameraQuarter);
  const end = projectPlanPoint(edge.end, cameraQuarter);
  const points = [
    start,
    end,
    { x: end.x, y: end.y + FLOOR_EDGE_HEIGHT },
    { x: start.x, y: start.y + FLOOR_EDGE_HEIGHT },
  ];
  const fill =
    edge.material === "oak" ? palette.oakDark : palette.tileDark;
  fillPixelPolygon(context, points, fill);
  drawPixelLine(context, start, end, palette.outline);
  drawPixelLine(
    context,
    { x: start.x, y: start.y + FLOOR_EDGE_HEIGHT },
    { x: end.x, y: end.y + FLOOR_EDGE_HEIGHT },
    palette.outlineSoft,
  );
}

function wallDepth(
  wall: CompiledWallSegment,
  cameraQuarter: CameraQuarter,
): number {
  const start = rotateAroundOrigin(
    centeredPlanPoint(wall.start),
    cameraQuarter,
  );
  const end = rotateAroundOrigin(
    centeredPlanPoint(wall.end),
    cameraQuarter,
  );
  return start.x + start.z + end.x + end.z;
}

function wallPlaneFill(
  wall: CompiledWallSegment,
  cameraQuarter: CameraQuarter,
): string {
  if (wall.finish === "glass") {
    return palette.glassLight;
  }
  if (wall.finish === "tile") {
    return palette.wallMid;
  }
  const start = rotateAroundOrigin(
    centeredPlanPoint(wall.start),
    cameraQuarter,
  );
  const end = rotateAroundOrigin(
    centeredPlanPoint(wall.end),
    cameraQuarter,
  );
  return Math.abs(end.x - start.x) > Math.abs(end.z - start.z)
    ? palette.wallLight
    : palette.wallMid;
}

function isRearWall(
  wall: CompiledWallSegment,
  cameraQuarter: CameraQuarter,
): boolean {
  const normal = rotateAroundOrigin(wall.outwardNormal, cameraQuarter);
  return normal.x < 0 || normal.z < 0;
}

function wallHeight(
  wall: CompiledWallSegment,
  cameraQuarter: CameraQuarter,
): number {
  const rear = isRearWall(wall, cameraQuarter);
  if (wall.kind === "exterior") {
    return rear ? 52 : 0;
  }
  if (wall.kind === "glass-balustrade") {
    return 18;
  }
  if (wall.kind === "sliding-glazing") {
    return rear ? 42 : 8;
  }
  return rear ? 24 : 8;
}

function drawWall(
  context: CanvasRenderingContext2D,
  wall: CompiledWallSegment,
  cameraQuarter: CameraQuarter,
): void {
  const height = wallHeight(wall, cameraQuarter);
  if (height === 0) {
    return;
  }
  const start = projectPlanPoint(wall.start, cameraQuarter);
  const end = projectPlanPoint(wall.end, cameraQuarter);
  const topStart = { x: start.x, y: start.y - height };
  const topEnd = { x: end.x, y: end.y - height };
  const points = [start, end, topEnd, topStart];

  if (wall.finish !== "glass") {
    fillPixelPolygon(context, points, wallPlaneFill(wall, cameraQuarter));
  }

  const outline =
    wall.finish === "glass" ? palette.glassDark : palette.outlineSoft;
  drawPixelLine(context, topStart, topEnd, outline, 2);
  drawPixelLine(context, start, end, palette.outlineSoft, 2);

  if (wall.startCap) {
    drawPixelLine(context, start, topStart, outline, 2);
  }
  if (wall.endCap) {
    drawPixelLine(context, end, topEnd, outline, 2);
  }

  if (wall.finish === "paint") {
    drawPixelLine(
      context,
      { x: topStart.x, y: topStart.y + 3 },
      { x: topEnd.x, y: topEnd.y + 3 },
      palette.wallShade,
    );
    drawPixelLine(
      context,
      { x: start.x, y: start.y - 4 },
      { x: end.x, y: end.y - 4 },
      palette.oakDark,
      2,
    );
  } else if (wall.finish === "tile") {
    for (let offset = 16; offset < height; offset += 16) {
      drawPixelLine(
        context,
        { x: start.x, y: start.y - offset },
        { x: end.x, y: end.y - offset },
        palette.tileDark,
      );
    }
  } else {
    drawPixelLine(
      context,
      { x: start.x, y: start.y - 4 },
      { x: end.x, y: end.y - 4 },
      palette.glassDark,
      2,
    );
    drawPixelLine(
      context,
      { x: topStart.x, y: topStart.y + 4 },
      { x: topEnd.x, y: topEnd.y + 4 },
      palette.glassMid,
    );
    const isSliderMullion =
      wall.id === "living-slider" &&
      (wall.start.x === 3.5 || wall.start.x === 5.5);
    if (isSliderMullion) {
      drawPixelLine(
        context,
        start,
        { x: start.x, y: start.y - height },
        palette.glassDark,
        2,
      );
    }
  }
}

export function renderApartmentShell(
  context: CanvasRenderingContext2D,
  cameraQuarter: CameraQuarter,
): void {
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  const edges = boundaryEdges();
  for (const edge of edges) {
    if (isFrontEdge(edge, cameraQuarter)) {
      drawFloorEdge(context, edge, cameraQuarter);
    }
  }

  const cells = [...apartmentFloorCells()].sort((left, right) => {
    const leftPoint = rotateAroundOrigin(
      centeredPlanPoint(left),
      cameraQuarter,
    );
    const rightPoint = rotateAroundOrigin(
      centeredPlanPoint(right),
      cameraQuarter,
    );
    return leftPoint.x + leftPoint.z - (rightPoint.x + rightPoint.z);
  });
  for (const cell of cells) {
    drawFloorCell(context, cell, cameraQuarter);
  }

  const walls = [...compileWallRuns()];
  walls.sort(
    (left, right) =>
      wallDepth(left, cameraQuarter) - wallDepth(right, cameraQuarter),
  );
  for (const wall of walls) {
    drawWall(context, wall, cameraQuarter);
  }
}
