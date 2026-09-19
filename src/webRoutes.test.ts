import assert from "node:assert/strict";
import test from "node:test";

import { appRoutePath, matchAppRoute } from "./webRoutes.js";

test("application routes remain relative to root and nested Vite bases", () => {
  assert.equal(appRoutePath("HOME", "/"), "/");
  assert.equal(appRoutePath("ERA_DRAFT", "/"), "/era-draft");
  assert.equal(appRoutePath("CLASSIC", "/"), "/classic");
  assert.equal(appRoutePath("HOME", "/games/era-draft/"), "/games/era-draft/");
  assert.equal(appRoutePath("ERA_DRAFT", "/games/era-draft/"), "/games/era-draft/era-draft");
  assert.equal(appRoutePath("CLASSIC", "/games/era-draft/"), "/games/era-draft/classic");
});

test("route matching rejects paths outside the configured application base", () => {
  assert.equal(matchAppRoute("/games/era-draft/", "/games/era-draft/"), "HOME");
  assert.equal(matchAppRoute("/games/era-draft/era-draft", "/games/era-draft/"), "ERA_DRAFT");
  assert.equal(matchAppRoute("/games/era-draft/classic/", "/games/era-draft/"), "CLASSIC");
  assert.equal(matchAppRoute("/era-draft", "/games/era-draft/"), null);
  assert.equal(matchAppRoute("/games/era-draft/unknown", "/games/era-draft/"), null);
});

