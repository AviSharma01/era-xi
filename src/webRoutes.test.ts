import assert from "node:assert/strict";
import test from "node:test";

import { appRoutePath, matchAppRoute, draftOffEnabled } from "./webRoutes.js";

test("Draft-Off requires an explicit release flag, including direct nested room routes", () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true "]) assert.equal(draftOffEnabled(value), false);
  assert.equal(draftOffEnabled("true"), true);
  for (const base of ["/", "/games/"]) {
    for (const path of [`${base}draft-off`, `${base}draft-off/rooms/0123456789AB`]) {
      assert.equal(matchAppRoute(path, base, false), null);
      assert.equal(matchAppRoute(path, base, true), "DRAFT_OFF");
    }
    for (const enabled of [false, true]) {
      assert.equal(matchAppRoute(base, base, enabled), "HOME");
      assert.equal(matchAppRoute(`${base}classic`, base, enabled), "CLASSIC");
      assert.equal(matchAppRoute(`${base}era-draft`, base, enabled), "ERA_DRAFT");
    }
  }
});

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

