// connection.js — WebSocket lifecycle and Cookie Sync protocol negotiation.

export const PROTOCOL = 1;
const SERVICE = "cookie-sync";
const SUBPROTOCOL = "cookie-sync-v1";
const CAPABILITIES = ["domain", "url"];
const DAEMON_WS_URL = "ws://localhost:38247/ext";
const DAEMON_PING_URL = "http://localhost:38247/ping";
const WS_RECONNECT_BASE_DELAY = 2000;
const WS_RECONNECT_MAX_DELAY = 60000;
const MAX_EAGER_ATTEMPTS = 6;
const DAEMON_PING_TIMEOUT_MS = 1000;

let ws = null;
let ready = false;
let connecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let onMessageHandler = null;

export function init(handler) {
  onMessageHandler = handler;
  return connect({ resetBackoff: true });
}

export function send(msg) {
  return sendOn(ws, msg);
}

function sendOn(socket, msg) {
  if (socket !== ws || !ready || socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(msg));
    return true;
  } catch {
    socket.close();
    return false;
  }
}

export function getStatus() {
  return {
    connected: ready && ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer !== null || connecting,
  };
}

export function tryConnect() {
  return connect();
}

export function restartShortRetryWindow() {
  resetReconnectState();
  return connect({ resetBackoff: true });
}

async function connect({ resetBackoff = false } = {}) {
  if (connecting || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  // This guard covers the asynchronous HTTP ping as well as socket creation.
  connecting = true;
  try {
    if (resetBackoff) resetReconnectState();
    if (!await pingDaemon()) {
      scheduleReconnect();
      return;
    }
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    const socket = new WebSocket(DAEMON_WS_URL, SUBPROTOCOL);
    ws = socket;
    ready = false;
    const helloTimer = setTimeout(() => socket.close(), 2000);

    socket.onopen = () => {
      if (ws !== socket) { socket.close(); return; }
      try {
        socket.send(JSON.stringify({
          type: "hello", role: "extension", service: SERVICE,
          protocol: PROTOCOL, capabilities: CAPABILITIES,
        }));
      } catch {
        socket.close();
      }
    };
    socket.onmessage = async (event) => {
      if (ws !== socket) return;
      try {
        const command = JSON.parse(event.data);
        if (command.type === "hello") {
          if (!matchesService(command) || command.role !== "service") throw new Error();
          clearTimeout(helloTimer);
          ready = true;
          resetReconnectState();
          return;
        }
        if (!ready || command.protocol !== PROTOCOL || typeof command.id !== "string"
            || command.action !== "getCookies") throw new Error();
        if (onMessageHandler) {
          const result = await onMessageHandler(command);
          // A slow response on an old socket cannot be sent on its replacement.
          sendOn(socket, result);
        }
      } catch {
        console.warn("[cookie-sync] Protocol or request handling failed");
        socket.close(1002, "Protocol error");
      }
    };
    socket.onclose = () => {
      clearTimeout(helloTimer);
      if (ws !== socket) return;
      ws = null;
      ready = false;
      scheduleReconnect();
    };
    socket.onerror = () => {
      // Close this socket, never whichever socket happens to be current later.
      socket.close();
    };
  } catch {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const attempt = reconnectAttempts;
  if (reconnectAttempts < MAX_EAGER_ATTEMPTS) reconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * 2 ** attempt, WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function resetReconnectState() {
  reconnectAttempts = 0;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function matchesService(data) {
  return data?.service === SERVICE && data.protocol === PROTOCOL
    && Array.isArray(data.capabilities) && CAPABILITIES.every((c) => data.capabilities.includes(c));
}

async function pingDaemon() {
  try {
    const response = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(DAEMON_PING_TIMEOUT_MS), cache: "no-store",
    });
    return response.ok && matchesService(await response.json());
  } catch {
    return false;
  }
}
