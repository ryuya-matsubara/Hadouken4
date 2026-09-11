/*
 * Hadouken Battle - online mode configuration.
 * ============================================
 * Set WEBSOCKET_URL to the value of the "WebSocketURL" output printed by the
 * CloudFormation stack after you deploy backend/template.yaml, e.g.:
 *
 *   wss://abc123def.execute-api.ap-northeast-1.amazonaws.com/prod
 *
 * While this is left as null / empty, the "ONLINE BATTLE" button on the home
 * screen shows a friendly "not configured yet" message and the offline
 * (same-device) game keeps working exactly as before.
 *
 * This file contains NO secrets — the WebSocket URL is a public endpoint — so
 * it is safe to commit and to serve from GitHub Pages.
 */
window.HADOUKEN_ONLINE_CONFIG = {
  // Paste your deployed WebSocket URL here:
  WEBSOCKET_URL: "wss://ylb3wopy88.execute-api.ap-northeast-1.amazonaws.com/prod",
};
