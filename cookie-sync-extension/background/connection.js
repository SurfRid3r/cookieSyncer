// connection.js — WebSocket lifecycle management

const DAEMON_PORT = 19825;
const DAEMON_HOST = "localhost";
const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
const DAEMON_PING_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/ping`;
const WS_RECONNECT_BASE_DELAY = 2000;
const WS_RECONNECT_MAX_DELAY = 60000;
const MAX_EAGER_ATTEMPTS = 6;
const DAEMON_PING_TIMEOUT_MS = 1000;

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let onMessageHandler = null;

/**
 * Initialize connection with a message handler.
 */
export function init(handler) {
  onMessageHandler = handler;
  connect({ resetBackoff: true });
}

/**
 * Send a JSON message over WebSocket.
 */
export function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[cookie-sync] Failed to send message:", err);
      scheduleReconnect();
    }
  }
}

/**
 * Get current connection status.
 */
export function getStatus() {
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer !== null,
  };
}

/**
 * Attempt connection (called by keepalive alarm).
 */
export function tryConnect() {
  connect();
}

/**
 * Restart the short-term reconnect window from the beginning.
 */
export function restartShortRetryWindow() {
  resetReconnectState();
  connect({ resetBackoff: true });
}

async function connect({ resetBackoff = false } = {}) {
  const wsState = ws?.readyState;
  if (wsState === WebSocket.OPEN || wsState === WebSocket.CONNECTING) return;

  if (resetBackoff) {
    resetReconnectState();
  }

  const daemonReachable = await pingDaemon();
  if (!daemonReachable) {
    scheduleReconnect();
    return;
  }

  try {
    ws = new WebSocket(DAEMON_WS_URL);
  } catch (err) {
    console.warn("[cookie-sync] Failed to create daemon WebSocket:", err);
    ws = null;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[cookie-sync] Connected to daemon");
    resetReconnectState();
    sendHello();
  };

  ws.onmessage = async (event) => {
    try {
      const command = JSON.parse(event.data);
      if (onMessageHandler) {
        const result = await onMessageHandler(command);
        send(result);
      }
    } catch (err) {
      console.error("[cookie-sync] Message handling error:", err);
    }
  };

  ws.onclose = () => {
    console.log("[cookie-sync] Disconnected from daemon");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (event) => {
    console.warn("[cookie-sync] WebSocket error event:", event);
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const attempt = reconnectAttempts;
  if (reconnectAttempts < MAX_EAGER_ATTEMPTS) {
    reconnectAttempts++;
  }
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, attempt), WS_RECONNECT_MAX_DELAY);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function resetReconnectState() {
  reconnectAttempts = 0;
  clearReconnectTimer();
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function sendHello() {
  ws?.send(JSON.stringify({
    type: "hello",
    version: chrome.runtime.getManifest().version,
  }));
}

async function pingDaemon() {
  try {
    const response = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(DAEMON_PING_TIMEOUT_MS),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}
