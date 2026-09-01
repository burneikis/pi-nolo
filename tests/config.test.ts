import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadConfig as loadConfigFromDisk,
  DEFAULT_SAFE_PREFIXES,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_SEGMENT_DANGEROUS_PATTERNS,
  DEFAULT_SHORTCUT,
} from "../src/config.js";

// loadConfig reads from PI_CODING_AGENT_DIR/nolo.json (or homedir()/.pi/agent/nolo.json) and .pi/nolo.json.
// We test it in the project directory context by writing a .pi/nolo.json
// in a temp working directory and changing process.cwd via cd isn't possible
// in-process, so we write directly to .pi/nolo.json relative to cwd instead.

const PROJECT_CFG = join(".pi", "nolo.json");
const EMPTY_HOME = join(tmpdir(), "pi-nolo-test-empty-home");
const AGENT_DIR = join(tmpdir(), "pi-nolo-test-agent-dir");
const loadConfig = (extra: { env?: Record<string, string | undefined> } = {}) =>
  loadConfigFromDisk({ homeDir: EMPTY_HOME, ...extra });

function cleanProjectCfg() {
  if (existsSync(PROJECT_CFG)) rmSync(PROJECT_CFG, { force: true });
}

describe("loadConfig", () => {
  after(() => {
    cleanProjectCfg();
    rmSync(AGENT_DIR, { recursive: true, force: true });
  });

  it("returns defaults when no config files exist", () => {
    cleanProjectCfg();
    const cfg = loadConfig();
    assert.deepEqual(cfg.safePrefixes, DEFAULT_SAFE_PREFIXES);
    assert.equal(cfg.dangerousRegexes.length, DEFAULT_DANGEROUS_PATTERNS.length);
    assert.equal(cfg.segmentDangerousRegexes.length, DEFAULT_SEGMENT_DANGEROUS_PATTERNS.length);
  });

  it("loads global config from PI_CODING_AGENT_DIR", () => {
    cleanProjectCfg();
    rmSync(AGENT_DIR, { recursive: true, force: true });
    mkdirSync(AGENT_DIR, { recursive: true });
    writeFileSync(join(AGENT_DIR, "nolo.json"), JSON.stringify({ shortcut: "ctrl+alt+y" }));

    assert.equal(
      loadConfigFromDisk({ env: { PI_CODING_AGENT_DIR: AGENT_DIR } }).shortcut,
      "ctrl+alt+y",
    );
  });

  it("merges extra safePrefixes from project config", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ safePrefixes: ["myctl status"] }));
    const cfg = loadConfig();
    assert.ok(cfg.safePrefixes.includes("myctl status"));
    assert.ok(cfg.safePrefixes.includes("ls"), "defaults are preserved");
    cleanProjectCfg();
  });

  it("project config deduplucates existing safe prefixes", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ safePrefixes: ["ls", "cat"] }));
    const cfg = loadConfig();
    const lsCount = cfg.safePrefixes.filter((p) => p === "ls").length;
    assert.equal(lsCount, 1);
    cleanProjectCfg();
  });

  it("project dangerousPatterns fully overrides defaults", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ dangerousPatterns: ["\\bkill\\b"] }));
    const cfg = loadConfig();
    assert.equal(cfg.dangerousRegexes.length, 1);
    assert.ok(cfg.dangerousRegexes[0].test("kill 1234"));
    cleanProjectCfg();
  });

  it("returns compiled RegExp objects for dangerous patterns", () => {
    cleanProjectCfg();
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
    cleanProjectCfg();
  });

  it("project segmentDangerousPatterns fully overrides defaults", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ segmentDangerousPatterns: ["^python\\b"] }));
    const cfg = loadConfig();
    assert.equal(cfg.segmentDangerousRegexes.length, 1);
    assert.ok(cfg.segmentDangerousRegexes[0].test("python script.py"));
    cleanProjectCfg();
  });

  it("returns default segment dangerous regexes when not overridden", () => {
    cleanProjectCfg();
    const cfg = loadConfig();
    for (const re of cfg.segmentDangerousRegexes) {
      assert.ok(re instanceof RegExp);
    }
  });

  it("returns the default shortcut when no config files exist", () => {
    cleanProjectCfg();
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
    cleanProjectCfg();
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
    cleanProjectCfg();
  });

  it("defaults the YOLO mode to off when no config exists", () => {
    cleanProjectCfg();
    assert.equal(loadConfig().defaultYoloMode, "off");
  });

  it("project defaultYoloMode overrides the default", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ defaultYoloMode: "full" }));
    assert.equal(loadConfig().defaultYoloMode, "full");
    cleanProjectCfg();
  });

  it("ignores unknown defaultYoloMode values", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ defaultYoloMode: "yolo" }));
    assert.equal(loadConfig().defaultYoloMode, "off");
    cleanProjectCfg();
  });

  it("defaults scope-writes to false when no config exists", () => {
    cleanProjectCfg();
    assert.equal(loadConfig().defaultScopeWrites, false);
  });

  it("project defaultScopeWrites overrides the default", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ defaultScopeWrites: true }));
    assert.equal(loadConfig().defaultScopeWrites, true);
    cleanProjectCfg();
  });

  it("ignores non-boolean defaultScopeWrites values", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ defaultScopeWrites: "yes" }));
    assert.equal(loadConfig().defaultScopeWrites, false);
    cleanProjectCfg();
  });

  it("defaults strictNonInteractive to false when no config exists", () => {
    cleanProjectCfg();
    assert.equal(loadConfig({ env: {} }).strictNonInteractive, false);
  });

  it("project strictNonInteractive overrides the default", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ strictNonInteractive: true }));
    assert.equal(loadConfig({ env: {} }).strictNonInteractive, true);
    cleanProjectCfg();
  });

  it("ignores non-boolean strictNonInteractive values", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ strictNonInteractive: "yes" }));
    assert.equal(loadConfig({ env: {} }).strictNonInteractive, false);
    cleanProjectCfg();
  });

  it("defaults bellOnConfirm to true when no config exists", () => {
    cleanProjectCfg();
    assert.equal(loadConfig({ env: {} }).bellOnConfirm, true);
  });

  it("project bellOnConfirm overrides the default", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ bellOnConfirm: false }));
    assert.equal(loadConfig({ env: {} }).bellOnConfirm, false);
    cleanProjectCfg();
  });

  it("ignores non-boolean bellOnConfirm values", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ bellOnConfirm: "no" }));
    assert.equal(loadConfig({ env: {} }).bellOnConfirm, true);
    cleanProjectCfg();
  });

  it("defaults bellOnIdle to true when no config exists", () => {
    cleanProjectCfg();
    assert.equal(loadConfig({ env: {} }).bellOnIdle, true);
  });

  it("project bellOnIdle overrides the default independently of bellOnConfirm", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ bellOnIdle: false }));
    const cfg = loadConfig({ env: {} });
    assert.equal(cfg.bellOnIdle, false);
    assert.equal(cfg.bellOnConfirm, true);
    cleanProjectCfg();
  });

  it("ignores non-boolean bellOnIdle values", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ bellOnIdle: "no" }));
    assert.equal(loadConfig({ env: {} }).bellOnIdle, true);
    cleanProjectCfg();
  });

  it("NOLO_STRICT env var overrides config", () => {
    mkdirSync(".pi", { recursive: true });
    writeFileSync(PROJECT_CFG, JSON.stringify({ strictNonInteractive: false }));
    assert.equal(loadConfig({ env: { NOLO_STRICT: "1" } }).strictNonInteractive, true);
    assert.equal(loadConfig({ env: { NOLO_STRICT: "true" } }).strictNonInteractive, true);
    writeFileSync(PROJECT_CFG, JSON.stringify({ strictNonInteractive: true }));
    assert.equal(loadConfig({ env: { NOLO_STRICT: "0" } }).strictNonInteractive, false);
    assert.equal(loadConfig({ env: { NOLO_STRICT: "false" } }).strictNonInteractive, false);
    cleanProjectCfg();
  });
});
