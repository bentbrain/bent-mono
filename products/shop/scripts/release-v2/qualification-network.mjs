import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const origins = JSON.parse(process.env.SHOP_QUALIFICATION_ORIGINS);
if (!Array.isArray(origins) || !origins.length || origins.length > 16 || origins.some(value =>
  typeof value !== 'string' || !/^https:\/\/[a-z0-9][a-z0-9.-]+$/.test(value) || new URL(value).origin !== value)) throw Error('Protected qualification HTTPS origins required');
const hosts = new Set(origins.map(value => new URL(value).hostname));
const connect = net.Socket.prototype.connect, secure = tls.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!options || typeof options !== 'object' || !hosts.has(options.host) || Number(options.port) !== 443 || options.path) throw Error('Qualification network target denied');
  return connect.apply(this, args);
};
tls.connect = function (options, ...args) {
  if (!options || typeof options !== 'object' || !hosts.has(options.host) || Number(options.port ?? 443) !== 443 ||
    options.servername && options.servername !== options.host || options.rejectUnauthorized === false || options.ca || options.checkServerIdentity || options.socket) throw Error('Qualification TLS target denied');
  return secure.call(this, { ...options, rejectUnauthorized: true, servername: options.host }, ...args);
};
dgram.createSocket = () => { throw Error('Qualification UDP target denied'); };
dgram.Socket.prototype.send = () => { throw Error('Qualification UDP target denied'); };
syncBuiltinESMExports();
