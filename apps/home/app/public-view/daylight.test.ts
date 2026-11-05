import {expect,test} from 'bun:test';
import {APARTMENT_LOCATION,apartmentSunlight,defaultLightLevel} from './daylight';
import {DEFAULT_ENVIRONMENT,sunlightFromPosition} from '../lighting';

test('Apartment sun agrees with Astral, the HA solar library, through the day and seasons',()=>{
 // Astral 3.2 Observer(-27.5,153), refraction enabled, synthetic location.
 // The independent reference is separate from the SunCalc implementation.
 const fixtures:[string,number,number][]=[
  ['2026-09-10T06:00:00+10:00',1.29149,83.79682],
  ['2026-09-10T09:00:00+10:00',38.58484,57.22548],
  ['2026-09-10T12:00:00+10:00',57.33501,353.13609],
  ['2026-09-10T17:00:00+10:00',7.77063,279.62156],
  ['2026-12-21T12:00:00+10:00',84.83587,321.10723],
  ['2026-06-21T12:00:00+10:00',39.02178,356.96942],
 ];
 for(const [time,elevation,azimuth] of fixtures){
  const sun=apartmentSunlight(new Date(time));
  expect(Math.abs(sun.elevation-elevation)).toBeLessThan(.05);
  expect(Math.abs(sun.azimuth-azimuth)).toBeLessThan(.05);
  expect(sun.source).toBe('astronomical');
 }
});
test('Visitor time zones do not affect daylight; night has no direct sunlight',()=>{
 expect(apartmentSunlight(new Date('2026-09-10T09:00:00+10:00'))).toEqual(apartmentSunlight(new Date('2026-09-09T23:00:00Z')));
 const night=apartmentSunlight(new Date('2026-09-10T20:00:00+10:00'));
 expect(night.daylight).toBe(0);expect(night.direct).toBe(0);
});
test('NE balcony and HA sunlight share the same world-direction mapping',()=>{
 const sun=sunlightFromPosition(30,41,DEFAULT_ENVIRONMENT.balconyBearing,'astronomical');
 expect(sun.direction.x).toBeCloseTo(0);expect(sun.direction.y).toBeCloseTo(-.5);expect(sun.direction.z).toBeGreaterThan(0);
});
test('Solar configuration uses the supplied synthetic test location',()=>{
 expect(APARTMENT_LOCATION.latitude).toBe(-27.5);
 expect(APARTMENT_LOCATION.longitude).toBe(153);
 expect(APARTMENT_LOCATION.altitudeMetres).toBe(10);
 expect(DEFAULT_ENVIRONMENT.balconyBearing).toBe(41);
});
test('Sun rays enter from the measured outward bearing and move across its sides',()=>{
 const direction=(azimuth:number)=>sunlightFromPosition(30,azimuth,DEFAULT_ENVIRONMENT.balconyBearing,'astronomical').direction;
 expect(direction(41).z).toBeGreaterThan(0);
 expect(direction(131).x).toBeLessThan(0);
 expect(direction(311).x).toBeGreaterThan(0);
 expect(direction(221).z).toBeLessThan(0);
 const morning=apartmentSunlight(new Date('2026-09-11T09:00:00+10:00'));
 const afternoon=apartmentSunlight(new Date('2026-09-11T17:00:00+10:00'));
 expect(morning.direction.z).toBeGreaterThan(0);
 expect(afternoon.direction.z).toBeLessThan(0);
});

test('Room defaults turn off in sufficient daylight in summer and winter',()=>{
 for(const date of ['2026-09-11','2026-06-21','2026-12-21']){
  expect(defaultLightLevel(apartmentSunlight(new Date(date+'T09:00:00+10:00')))).toBe(0);
  expect(defaultLightLevel(apartmentSunlight(new Date(date+'T12:00:00+10:00')))).toBe(0);
  expect(defaultLightLevel(apartmentSunlight(new Date(date+'T21:00:00+10:00')))).toBe(55);
 }
});
test('Room defaults fade through twilight using the same light level as the scene',()=>{
 const levels=[-8,-4,0,4,8,12,16].map(elevation=>defaultLightLevel(sunlightFromPosition(elevation,45,45,'astronomical')));
 expect(levels[0]).toBe(55);expect(levels.at(-1)).toBe(0);
 for(let i=1;i<levels.length;i++)expect(levels[i]).toBeLessThan(levels[i-1]??0);
 expect(defaultLightLevel(null)).toBe(0);
});
