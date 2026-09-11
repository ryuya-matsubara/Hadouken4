"use strict";
/*
 * A tiny in-memory stand-in for the DynamoDB DocumentClient used by rooms.js.
 * It implements just enough of Get/Put/Update/Delete + ConditionExpression
 * semantics for the specific expressions our code issues, so we can unit-test
 * the room-level concurrency & idempotency contract WITHOUT AWS.
 *
 * Supported condition primitives (evaluated against the current item):
 *   attribute_not_exists(path)
 *   attribute_exists(path)
 *   #a = :v      /  #a <> :v
 *   AND / OR (flat, left-to-right)
 *   nested paths a.b.c via ExpressionAttributeNames
 *
 * This is deliberately minimal and matches our own expressions only.
 */

class ConditionalCheckFailedException extends Error {
  constructor(msg) {
    super(msg || "The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

function resolveName(token, names) {
  if (token.startsWith("#")) return names[token];
  return token;
}

// Get a nested value by a path array from an object.
function getPath(obj, pathArr) {
  let cur = obj;
  for (const p of pathArr) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
function setPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const p = pathArr[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

// Turn "actions.#t.#p" into ["actions","<turn>","<slot>"] using names map.
function pathTokens(expr, names) {
  return expr.split(".").map((tok) => resolveName(tok.trim(), names));
}

// Recursive-descent evaluator supporting parentheses, AND, OR and the leaf
// clauses. Precedence: OR (lowest) < AND < primary/parenthesised.
function evalCondition(expr, item, names, values) {
  if (!expr) return true;
  const tokens = tokenizeCond(expr);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseOr() {
    let left = parseAnd();
    while (peek() === "OR") { next(); const right = parseAnd(); left = left || right; }
    return left;
  }
  function parseAnd() {
    let left = parsePrimary();
    while (peek() === "AND") { next(); const right = parsePrimary(); left = left && right; }
    return left;
  }
  function parsePrimary() {
    const tok = peek();
    if (tok === "(") {
      next();
      const val = parseOr();
      if (peek() === ")") next();
      return val;
    }
    // A leaf clause token.
    next();
    return evalClause(tok, item, names, values);
  }

  return parseOr();
}

// Split a condition string into tokens: "(", ")", "AND", "OR", and leaf
// clauses (everything else, e.g. "attribute_exists(roomId)" or "#s = :waiting").
function tokenizeCond(expr) {
  const tokens = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const ch = expr[i];
    if (ch === " ") { i++; continue; }
    if (ch === "(") {
      // Could be a function call like attribute_exists(...) OR a grouping paren.
      // Look back: if the token so far started a function name we handle it in
      // the clause reader. Here a bare "(" is a grouping paren.
      tokens.push("(");
      i++;
      continue;
    }
    if (ch === ")") { tokens.push(")"); i++; continue; }
    // Read a word.
    if (/[A-Za-z_#:]/.test(ch)) {
      let j = i;
      let word = "";
      // function-call clause: name(...) -> consume balanced parens
      while (j < n && /[A-Za-z_]/.test(expr[j])) { word += expr[j]; j++; }
      if (expr[j] === "(") {
        // consume until matching close paren
        let depth = 0;
        let clause = word;
        while (j < n) {
          clause += expr[j];
          if (expr[j] === "(") depth++;
          else if (expr[j] === ")") { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
        tokens.push(clause);
        i = j;
        continue;
      }
      // keyword AND/OR
      if (word === "AND" || word === "OR") { tokens.push(word); i = j; continue; }
      // comparison clause: read until AND/OR/paren boundary
      let clause = "";
      let k = i;
      while (k < n) {
        const rest = expr.slice(k);
        if (rest.startsWith(" AND ") || rest.startsWith(" OR ")) break;
        if (expr[k] === ")") break;
        clause += expr[k];
        k++;
      }
      tokens.push(clause.trim());
      i = k;
      continue;
    }
    i++;
  }
  return tokens;
}

function evalClause(clause, item, names, values) {
  let m;
  if ((m = clause.match(/^attribute_not_exists\(([^)]+)\)$/))) {
    const path = pathTokens(m[1], names);
    return getPath(item, path) === undefined;
  }
  if ((m = clause.match(/^attribute_exists\(([^)]+)\)$/))) {
    const path = pathTokens(m[1], names);
    return getPath(item, path) !== undefined;
  }
  if ((m = clause.match(/^(\S+)\s*<>\s*(\S+)$/))) {
    const left = getPath(item, pathTokens(m[1], names));
    const right = values[m[2]];
    return left !== right;
  }
  // Numeric comparisons: #a < :v and #a > :v. If the attribute is missing the
  // comparison is false (mirrors DynamoDB, which does not match absent attrs).
  if ((m = clause.match(/^(\S+)\s*<\s*(\S+)$/))) {
    const left = getPath(item, pathTokens(m[1], names));
    const right = values[m[2]];
    return left !== undefined && left < right;
  }
  if ((m = clause.match(/^(\S+)\s*>\s*(\S+)$/))) {
    const left = getPath(item, pathTokens(m[1], names));
    const right = values[m[2]];
    return left !== undefined && left > right;
  }
  if ((m = clause.match(/^(\S+)\s*=\s*(\S+)$/))) {
    const left = getPath(item, pathTokens(m[1], names));
    const right = values[m[2]];
    return left === right;
  }
  throw new Error("mockDdb: unsupported condition clause: " + clause);
}

// Apply a (small subset of) UpdateExpression to an item.
// Supports: SET a=:v, a.b=:v, a=if_not_exists(a,:v)  and  ADD version :n
function applyUpdate(item, expr, names, values) {
  // Separate SET ... and ADD ... sections.
  const setMatch = expr.match(/SET\s+(.*?)(?:\s+ADD\s+|$)/s);
  const addMatch = expr.match(/ADD\s+(.*)$/s);
  if (setMatch) {
    const assigns = splitTopLevel(setMatch[1]);
    for (const a of assigns) {
      const eq = a.indexOf("=");
      const lhs = a.slice(0, eq).trim();
      const rhs = a.slice(eq + 1).trim();
      const path = pathTokens(lhs, names);
      let val;
      let ifnx;
      if ((ifnx = rhs.match(/^if_not_exists\(([^,]+),\s*(\S+)\)$/))) {
        const existingPath = pathTokens(ifnx[1], names);
        const existing = getPath(item, existingPath);
        val = existing !== undefined ? existing : values[ifnx[2].trim()];
      } else {
        val = values[rhs];
      }
      setPath(item, path, deepClone(val));
    }
  }
  if (addMatch) {
    const parts = addMatch[1].split(",");
    for (const p of parts) {
      const [name, valTok] = p.trim().split(/\s+/);
      const path = pathTokens(name, names);
      const cur = getPath(item, path) || 0;
      setPath(item, path, cur + values[valTok]);
    }
  }
}

function splitTopLevel(s) {
  // Split on commas that are not inside parentheses.
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// The fake DocumentClient: send(command) where command is {__type, input}.
function createMockDoc() {
  const tables = {}; // tableName -> { key -> item }

  function keyName(tableName) {
    return tableName.includes("Connection") ? "connectionId" : "roomId";
  }

  return {
    _tables: tables,
    async send(command) {
      const t = command.__type;
      const input = command.input;
      const table = input.TableName;
      tables[table] = tables[table] || {};
      const kn = keyName(table);
      const keyVal = input.Key ? input.Key[kn] : input.Item[kn];

      if (t === "Get") {
        const item = tables[table][keyVal];
        return { Item: item ? deepClone(item) : undefined };
      }
      if (t === "Put") {
        const existing = tables[table][keyVal];
        if (
          input.ConditionExpression &&
          !evalCondition(input.ConditionExpression, existing || {}, input.ExpressionAttributeNames || {}, input.ExpressionAttributeValues || {})
        ) {
          throw new ConditionalCheckFailedException();
        }
        tables[table][keyVal] = deepClone(input.Item);
        return {};
      }
      if (t === "Update") {
        const existing = tables[table][keyVal] || { [kn]: keyVal };
        if (
          input.ConditionExpression &&
          !evalCondition(input.ConditionExpression, existing, input.ExpressionAttributeNames || {}, input.ExpressionAttributeValues || {})
        ) {
          throw new ConditionalCheckFailedException();
        }
        applyUpdate(existing, input.UpdateExpression, input.ExpressionAttributeNames || {}, input.ExpressionAttributeValues || {});
        tables[table][keyVal] = existing;
        return { Attributes: deepClone(existing) };
      }
      if (t === "Delete") {
        delete tables[table][keyVal];
        return {};
      }
      throw new Error("mockDdb: unsupported command " + t);
    },
  };
}

// Command classes matching the shapes rooms.js imports from ddb.js
// (rooms.js calls them with `new`).
class GetCommand { constructor(input) { this.__type = "Get"; this.input = input; } }
class PutCommand { constructor(input) { this.__type = "Put"; this.input = input; } }
class UpdateCommand { constructor(input) { this.__type = "Update"; this.input = input; } }
class DeleteCommand { constructor(input) { this.__type = "Delete"; this.input = input; } }

module.exports = {
  createMockDoc,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ConditionalCheckFailedException,
};
