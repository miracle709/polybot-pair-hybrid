const WebSocket = globalThis.WebSocket ?? (await import('ws')).WebSocket;

export { WebSocket };
