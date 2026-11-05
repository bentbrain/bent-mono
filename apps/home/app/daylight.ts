import {getPosition} from 'suncalc';
import {APARTMENT_LOCATION} from './apartmentLocation';
import {sunlightFromPosition} from './lighting';

export function apartmentSunlight(date:Date,balconyBearing=APARTMENT_LOCATION.balconyBearing){
 const position=getPosition(date,APARTMENT_LOCATION.latitude,APARTMENT_LOCATION.longitude);
 return sunlightFromPosition(position.altitude,position.azimuth,balconyBearing,'astronomical');
}
