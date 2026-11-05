import type { CardinalDirection } from "@apartment-hotel/asset-contracts";

export type CameraQuarter = 0 | 1 | 2 | 3;

export interface GridPoint {
  readonly x: number;
  readonly z: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface IsometricProjection {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly origin: ScreenPoint;
}

const DIRECTION_ORDER: readonly CardinalDirection[] = [
  "north",
  "east",
  "south",
  "west",
];

export function nextCameraQuarter(quarter: CameraQuarter): CameraQuarter {
  if (quarter === 0) {
    return 1;
  }
  if (quarter === 1) {
    return 2;
  }
  if (quarter === 2) {
    return 3;
  }
  return 0;
}

export function previousCameraQuarter(quarter: CameraQuarter): CameraQuarter {
  if (quarter === 1) {
    return 0;
  }
  if (quarter === 2) {
    return 1;
  }
  if (quarter === 3) {
    return 2;
  }
  return 3;
}

export function rotateAroundOrigin(
  point: GridPoint,
  quarter: CameraQuarter,
): GridPoint {
  if (quarter === 1) {
    return { x: -point.z, z: point.x };
  }
  if (quarter === 2) {
    return { x: -point.x, z: -point.z };
  }
  if (quarter === 3) {
    return { x: point.z, z: -point.x };
  }
  return point;
}

export function projectIsometric(
  point: GridPoint,
  projection: IsometricProjection,
): ScreenPoint {
  return {
    x:
      projection.origin.x +
      (point.x - point.z) * (projection.tileWidth / 2),
    y:
      projection.origin.y +
      (point.x + point.z) * (projection.tileHeight / 2),
  };
}

export function projectWorldPoint(
  point: GridPoint,
  cameraQuarter: CameraQuarter,
  projection: IsometricProjection,
): ScreenPoint {
  return projectIsometric(
    rotateAroundOrigin(point, cameraQuarter),
    projection,
  );
}

export function directionForCamera(
  worldDirection: CardinalDirection,
  cameraQuarter: CameraQuarter,
): CardinalDirection {
  const currentIndex = DIRECTION_ORDER.indexOf(worldDirection);
  const relativeIndex = (currentIndex - cameraQuarter + 4) % 4;
  const direction = DIRECTION_ORDER[relativeIndex];
  if (direction === undefined) {
    return "north";
  }
  return direction;
}

export function rotateDirectionClockwise(
  direction: CardinalDirection,
): CardinalDirection {
  const currentIndex = DIRECTION_ORDER.indexOf(direction);
  const nextIndex = (currentIndex + 1) % 4;
  const nextDirection = DIRECTION_ORDER[nextIndex];
  if (nextDirection === undefined) {
    return "north";
  }
  return nextDirection;
}
