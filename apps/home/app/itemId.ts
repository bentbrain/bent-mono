/** Local HTTP Home Assistant installations cannot use crypto.randomUUID. */
export function createItemId(random:Pick<Crypto,'getRandomValues'>=crypto):string {
 return Array.from(random.getRandomValues(new Uint32Array(4)),word=>word.toString(16).padStart(8,'0')).join('');
}
