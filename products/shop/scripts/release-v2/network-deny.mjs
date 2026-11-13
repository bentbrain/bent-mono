import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const origins = JSON.parse(process.env.SHOP_FIXTURE_ORIGINS).map(value => new URL(value));
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  const port = typeof options === 'object' ? options.port : options;
  if (host !== '127.0.0.1' || !origins.some(origin => String(port) === origin.port)) throw Error('Journey network target denied');
  return originalConnect.apply(this, args);
};
tls.connect = () => { throw Error('Journey TLS target denied'); };
dgram.createSocket = () => { throw Error('Journey UDP target denied'); };
dgram.Socket.prototype.send = () => { throw Error('Journey UDP target denied'); };
syncBuiltinESMExports();
