import type {Sunlight} from '../lighting';
export {APARTMENT_LOCATION} from '../apartmentLocation';
export {apartmentSunlight} from '../daylight';

// Follow the renderer's natural-light curve: 55% at night, fading to 0%
// when full daylight is available (sun elevation >= 16 degrees).
export function defaultLightLevel(sun:Pick<Sunlight,'daylight'>|null):number {
 if(!sun)return 0;
 return Math.round(55*(1-Math.max(0,Math.min(1,sun.daylight))));
}
