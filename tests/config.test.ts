import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  loadConfig,
  DEFAULT_SAFE_PREFIXES,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_SEGMENT_DANGEROUS_PATTERNS,
  DEFAULT_SHORTCUT,
} from "../src/config.js";

// loadConfig reads from homedir()/.pi/agent/nolo.json and .pi/nolo.json.
// We test it in the project directory context by writing a .pi/nolo.json
// in a temp working directory and changing process.cwd via cd isn't possible
// in-process, so we write directly to .pi/nolo.json relative to cwd instead.

const PROJECT_CFG = join(".pi", "nolo.json");

function cleanProjectCfg() {
  if (existsSync(PROJECT_CFG)) rmSync(PROJECT_CFG, { force: true });
}

describe("loadConfig", () => {
  // Clean before and after each test so a thrown assertion never leaks a
  // leftover .pi/nolo.json into the next test.
  beforeEach(cleanProjectCfg);
  afterEach(cleanProjectCfg);

  it("returns defaults when no config files exist", () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.safePrefixes, DEFAULT_SAFE_PREFIXES);
    assert.equal(cfg.dangerousRegexes.length, DEFAULT_DANGEROUS_PATTERNS.length);
    assert.equal(cfg.segmentDangerousRegexes.length, DEFAULT_SEGMENT_DANGEROUS_PATTERNS.length);
  });

  it("merges extra safePrefixes from project config", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ safePrefixes: ["myctl status"] }));
    const cfg = loadConfig();
    assert.ok(cfg.safePrefixes.includes("myctl status"));
    assert.ok(cfg.safePrefixes.includes("ls"), "defaults are preserved");
  });

  it("project config deduplucates existing safe prefixes", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ safePrefixes: ["ls", "cat"] }));
    const cfg = loadConfig();
    const lsCount = cfg.safePrefixes.filter((p) => p === "ls").length;
    assert.equal(lsCount, 1);
  });

  it("falls back to defaults when safePrefixes is not an array", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ safePrefixes: {} }));
    // A non-array value must not throw during load (would leave the write
    // gate unregistered); it falls back to the known-valid defaults.
    const cfg = loadConfig();
    assert.deepEqual(cfg.safePrefixes, DEFAULT_SAFE_PREFIXES);
  });

  it("project dangerousPatterns fully overrides defaults", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ dangerousPatterns: ["\\bkill\\b"] }));
    const cfg = loadConfig();
    assert.equal(cfg.dangerousRegexes.length, 1);
    assert.ok(cfg.dangerousRegexes[0].test("kill 1234"));
  });

  it("returns compiled RegExp objects for dangerous patterns", () => {
    const cfg = loadConfig();
    for (const re of cfg.dangerousRegexes) {
      assert.ok(re instanceof RegExp);
    }
  });

  it("gracefully ignores malformed JSON config", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, "{ this is not json }");
    // Should not throw; falls back to defaults
    const cfg = loadConfig();
    assert.deepEqual(cfg.safePrefixes, DEFAULT_SAFE_PREFIXES);
  });

  it("project segmentDangerousPatterns fully overrides defaults", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ segmentDangerousPatterns: ["^python\\b"] }));
    const cfg = loadConfig();
    assert.equal(cfg.segmentDangerousRegexes.length, 1);
    assert.ok(cfg.segmentDangerousRegexes[0].test("python script.py"));
  });

  it("returns default segment dangerous regexes when not overridden", () => {
    const cfg = loadConfig();
    for (const re of cfg.segmentDangerousRegexes) {
      assert.ok(re instanceof RegExp);
    }
  });

  it("falls back to default dangerous patterns when a pattern is an invalid regex", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ dangerousPatterns: ["("] }));
    // An invalid user regex must not throw during load (would leave the write
    // gate unregistered); it falls back to the known-valid defaults.
    const cfg = loadConfig();
    assert.equal(cfg.dangerousRegexes.length, DEFAULT_DANGEROUS_PATTERNS.length);
  });

  it("falls back to default segment patterns when a pattern is an invalid regex", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ segmentDangerousPatterns: ["["] }));
    const cfg = loadConfig();
    assert.equal(
      cfg.segmentDangerousRegexes.length,
      DEFAULT_SEGMENT_DANGEROUS_PATTERNS.length,
    );
  });

  it("returns the default shortcut when no config files exist", () => {
    const cfg = loadConfig();
    assert.equal(cfg.shortcut, DEFAULT_SHORTCUT);
    assert.equal(cfg.shortcut, "ctrl+y");
  });

  // Override precedence is project > global > default. The test sandbox cannot
  // safely write to the real homedir global path, so this only exercises the
  // project override branch (the global branch in config.ts is structurally
  // identical and remains untested).
  it("project shortcut overrides the default", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ shortcut: "ctrl+shift+y" }));
    const cfg = loadConfig();
    assert.equal(cfg.shortcut, "ctrl+shift+y");
  });

  it("falls back to the default when shortcut is malformed or empty", () => {
    mkdirSync(".pi", { recursive: true });
    for (const bad of [123, "   ", "", null, true, ["ctrl+y"], {}]) {
      writeFileSync(PROJECT_CFG, JSON.stringify({ shortcut: bad }));
      assert.equal(
        loadConfig().shortcut,
        DEFAULT_SHORTCUT,
        `shortcut ${JSON.stringify(bad)} should fall back to default`,
      );
    }
  });
});
