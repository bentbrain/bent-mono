export function wifiQrValue(network: string, password: string): string {
  const escape = (value: string) => value.replace(/[\\;,:\"]/g, "\\$&");
  return `WIFI:T:WPA;S:${escape(network)};P:${escape(password)};;`;
}
