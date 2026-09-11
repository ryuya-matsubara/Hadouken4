"use strict";
/*
 * WebSocket messaging helpers for API Gateway Management API.
 * Sends JSON payloads to individual connections and cleans up stale ones.
 */
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");

let cachedClient = null;
let cachedEndpoint = null;

// Build the callback endpoint from the WebSocket event's request context.
function endpointFromEvent(event) {
  const { domainName, stage } = event.requestContext;
  return `https://${domainName}/${stage}`;
}

function clientFor(endpoint) {
  if (cachedClient && cachedEndpoint === endpoint) return cachedClient;
  cachedEndpoint = endpoint;
  cachedClient = new ApiGatewayManagementApiClient({ endpoint });
  return cachedClient;
}

// Send a message to a single connection. Returns true on success. If the
// connection is gone (410), returns false so the caller can prune it.
async function send(endpoint, connectionId, payload) {
  if (!connectionId) return false;
  const api = clientFor(endpoint);
  try {
    await api.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      })
    );
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.name === "GoneException") return false;
    // Re-throw genuine errors so they surface in logs; swallow gone connections.
    throw err;
  }
}

module.exports = { endpointFromEvent, send };
