function coordinate(name:string,value:string|undefined,min:number,max:number):number {
 if(value===undefined||value.trim()==='')throw new Error(`Configure ${name} before building Home`);
 const parsed=Number(value);
 if(!Number.isFinite(parsed)||parsed<min||parsed>max)throw new Error(`Invalid ${name}`);
 return parsed;
}
export const APARTMENT_LOCATION={
 latitude:coordinate('PUBLIC_HOME_LATITUDE',process.env.PUBLIC_HOME_LATITUDE,-90,90),
 longitude:coordinate('PUBLIC_HOME_LONGITUDE',process.env.PUBLIC_HOME_LONGITUDE,-180,180),
 balconyBearing:coordinate('PUBLIC_HOME_BALCONY_BEARING',process.env.PUBLIC_HOME_BALCONY_BEARING,0,360),
 altitudeMetres:coordinate('PUBLIC_HOME_ALTITUDE_METRES',process.env.PUBLIC_HOME_ALTITUDE_METRES,-1000,10000),
};
