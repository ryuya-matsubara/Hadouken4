"use strict";
/*
 * Thin DynamoDB helper wrapping the AWS SDK v3 DocumentClient. Centralises the
 * table names (from env) and the low-level operations used by the handlers.
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "ap-northeast-1";
const client = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const ROOMS_TABLE = process.env.ROOMS_TABLE;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;

// Rooms live at most this long (seconds). Refreshed on activity; finished rooms
// get a short TTL so they are cleaned up quickly.
const ROOM_TTL_SECONDS = 60 * 60; // 1 hour of inactivity
const FINISHED_TTL_SECONDS = 60 * 10; // 10 min after a match ends

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

module.exports = {
  doc,
  ROOMS_TABLE,
  CONNECTIONS_TABLE,
  ROOM_TTL_SECONDS,
  FINISHED_TTL_SECONDS,
  nowEpoch,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
};
