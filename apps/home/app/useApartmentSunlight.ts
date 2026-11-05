'use client';
import {useEffect,useState} from 'react';
import {APARTMENT_LOCATION} from './apartmentLocation';
import {apartmentSunlight} from './daylight';
import type {Sunlight} from './lighting';

export function useApartmentSunlight(balconyBearing=APARTMENT_LOCATION.balconyBearing){
 const [sun,setSun]=useState<Sunlight|null>(null);
 useEffect(()=>{
  const refresh=()=>{if(!document.hidden)setSun(apartmentSunlight(new Date(),balconyBearing));};
  refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[balconyBearing]);
 return sun;
}
