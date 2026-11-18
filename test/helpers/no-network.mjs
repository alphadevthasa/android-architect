// Preloaded via `node --import` so every test runs with the network blocked.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import tls from 'node:tls';

const blocked = () => {
  throw new Error('network disabled in tests');
};

globalThis.fetch = async () => blocked();
net.connect = blocked;
net.createConnection = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
dns.lookup = blocked;
tls.connect = blocked;
