export interface HomeAssistantEntityBinding {
  readonly sceneObjectId: string;
  readonly entityId: string;
}

export interface HomeAssistantRoomBinding {
  readonly roomId: string;
  readonly areaId: string;
  readonly entityIds: readonly string[];
}

export interface VacuumMapPoint {
  readonly x: number;
  readonly y: number;
}

export interface ApartmentWorldPoint {
  readonly x: number;
  readonly z: number;
}

export interface VacuumCalibration {
  readonly sourceMapId: string;
  readonly scale: number;
  readonly rotationRadians: number;
  readonly reflectY: boolean;
  readonly translation: ApartmentWorldPoint;
  readonly measuredErrorMeters: number;
}

export function mapVacuumPointToApartment(
  point: VacuumMapPoint,
  calibration: VacuumCalibration,
): ApartmentWorldPoint {
  const sourceY = calibration.reflectY ? -point.y : point.y;
  const scaledX = point.x * calibration.scale;
  const scaledY = sourceY * calibration.scale;
  const cosine = Math.cos(calibration.rotationRadians);
  const sine = Math.sin(calibration.rotationRadians);

  return {
    x:
      scaledX * cosine -
      scaledY * sine +
      calibration.translation.x,
    z:
      scaledX * sine +
      scaledY * cosine +
      calibration.translation.z,
  };
}
