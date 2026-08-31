#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.env.ZHS_REPO;
if (!repo) {
  throw new Error("ZHS_REPO must point to a local zudo-history-stash checkout");
}

const here = dirname(fileURLToPath(import.meta.url));
const pinPath = resolve(here, "../src/stash/contract-pin.json");
const pin = JSON.parse(readFileSync(pinPath, "utf8"));
const stashCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(stashCommit)) throw new Error("ZHS_REPO HEAD did not resolve to a full commit SHA");

function show(path) {
  return execFileSync("git", ["-C", repo, "show", `${stashCommit}:${path}`], { encoding: "utf8" });
}

function evaluateInteger(expression, constants) {
  const substituted = expression.replace(/\b[A-Z][A-Z0-9_]+\b/g, (name) => {
    if (!(name in constants)) throw new Error(`Unresolved limit expression name: ${name}`);
    return String(constants[name]);
  });
  if (!/^[\d\s_*+\-/()]+$/.test(substituted)) throw new Error(`Unsafe limit expression: ${expression}`);
  const value = Function(`"use strict"; return (${substituted})`)();
  if (!Number.isSafeInteger(value)) throw new Error(`Limit is not a safe integer: ${expression}`);
  return value;
}

const limits = {};
for (const match of show("packages/core/src/limits.ts").matchAll(/export const ([A-Z][A-Z0-9_]+) = ([^;]+);/g)) {
  limits[match[1]] = evaluateInteger(match[2], limits);
}

const errorsSource = show("packages/core/src/errors.ts");
const errorArray = /export const ERROR_CODES = \[([\s\S]*?)\] as const/.exec(errorsSource)?.[1];
if (!errorArray) throw new Error("Could not locate ERROR_CODES");
const errorCodes = [...errorArray.matchAll(/"([a-z][a-z-]+)"/g)].map((match) => match[1]);

const routesSource = show("packages/core/src/routes.ts");
for (const route of pin.routes) {
  const escapedId = route.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const record = new RegExp(`\\{[\\s\\S]*?id: "${escapedId}"[\\s\\S]*?method: "([A-Z]+)"[\\s\\S]*?template: "([^"]+)"[\\s\\S]*?principal: "([a-z-]+)"[\\s\\S]*?\\}`).exec(routesSource);
  if (!record) throw new Error(`Could not locate pinned route ${route.id}`);
  [, route.method, route.template, route.principal] = record;
}

pin.stashCommit = stashCommit;
pin.limits = limits;
pin.errorCodes = errorCodes;
writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
console.log(`refreshed ${pinPath} from ${stashCommit}`);
