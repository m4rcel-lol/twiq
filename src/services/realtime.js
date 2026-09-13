'use strict';

/**
 * Optional WebSocket fan-out.
 *
 * Twiq is a server-rendered site: every feature works with JavaScript
 * disabled and with the socket down. This layer only pushes *hints*
 * ("you have a new notification"), never authoritative state.
 */

const { WebSocketServer } = require('ws');
const config = require('../config/env');
const logger = require('../config/logger');

let wss = null;
/** @type {Map<number, Set<import('ws').WebSocket>>} */
const clients = new Map();

function attach(server, sessionParser) {
  if (!config.features.websockets) return null;

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    sessionParser(req, {}, () => {
      const userId = req.session && req.session.userId;
      if (!userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = userId;
        ws.isAlive = true;
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws) => {
    if (!clients.has(ws.userId)) clients.set(ws.userId, new Set());
    clients.get(ws.userId).add(ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => logger.debug({ err }, 'websocket error'));
    ws.on('close', () => {
      const set = clients.get(ws.userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clients.delete(ws.userId);
      }
    });
    ws.send(JSON.stringify({ type: 'hello' }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 30000);
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));
  logger.info('websocket server attached at /ws');
  return wss;
}

/** Push an event to every live socket belonging to a user. */
function publish(userId, payload) {
  const set = clients.get(Number(userId));
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch (err) {
        logger.debug({ err }, 'websocket publish failed');
      }
    }
  }
}

/**
 * The ids with a socket open right now.
 *
 * A new Tweet has to reach its author's followers, and that list can be
 * long. Asking who is actually listening first means the fan-out query only
 * considers people who could receive anything.
 */
function connectedUserIds() {
  return [...clients.keys()];
}

async function close() {
  if (!wss) return;
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  await new Promise((resolve) => wss.close(resolve));
  clients.clear();
  wss = null;
}

module.exports = { attach, publish, connectedUserIds, close };
