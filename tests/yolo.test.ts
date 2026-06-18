import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createYoloState,
  restoreYoloMode,
  renderStatus,
  cycleYoloMode,
  toggleScopeWrites,
  restoreScopeWrites,
} from "../src/yolo.js";
import { YOLO_ENTRY_TYPE, SCOPE_WRITES_ENTRY_TYPE } from "../src/types.js";

// Minimal theme stub
const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
};

describe("createYoloState", () => {
  it("starts in off mode", () => {
    const state = createYoloState();
    assert.equal(state.mode, "off");
  });
});

describe("restoreYoloMode", () => {
  it("does nothing when entries are empty", () => {
    const state = createYoloState();
    restoreYoloMode([], state);
    assert.equal(state.mode, "off");
  });

  it("restores mode from last yolo entry", () => {
    const state = createYoloState();
    const entries = [
      { type: "custom", customType: YOLO_ENTRY_TYPE, data: { mode: "writes" } },
    ];
    restoreYoloMode(entries, state);
    assert.equal(state.mode, "writes");
  });

  it("restores full mode", () => {
    const state = createYoloState();
    const entries = [
      { type: "custom", customType: YOLO_ENTRY_TYPE, data: { mode: "full" } },
    ];
    restoreYoloMode(entries, state);
    assert.equal(state.mode, "full");
  });

  it("uses the last yolo entry when multiple exist", () => {
    const state = createYoloState();
    const entries = [
      { type: "custom", customType: YOLO_ENTRY_TYPE, data: { mode: "writes" } },
      { type: "custom", customType: YOLO_ENTRY_TYPE, data: { mode: "full" } },
    ];
    restoreYoloMode(entries, state);
    assert.equal(state.mode, "full");
  });

  it("ignores entries of other types", () => {
    const state = createYoloState();
    const entries = [
      { type: "custom", customType: "something-else", data: { mode: "full" } },
      { type: "message", data: {} },
    ];
    restoreYoloMode(entries, state);
    assert.equal(state.mode, "off");
  });

  it("ignores invalid mode value in entry", () => {
    const state = createYoloState();
    const entries = [
      { type: "custom", customType: YOLO_ENTRY_TYPE, data: { mode: "turbo" } },
    ];
    restoreYoloMode(entries, state);
    assert.equal(state.mode, "off");
  });
});

describe("renderStatus", () => {
  it("renders off mode as dim", () => {
    const state = createYoloState();
    const result = renderStatus(state, theme);
    assert.match(result, /\[dim\]/);
    assert.match(result, /nolo/);
  });

  it("renders writes mode as warning", () => {
    const state = createYoloState();
    state.mode = "writes";
    const result = renderStatus(state, theme);
    assert.match(result, /\[warning\]/);
    assert.match(result, /writes/);
  });

  it("renders full mode as error", () => {
    const state = createYoloState();
    state.mode = "full";
    const result = renderStatus(state, theme);
    assert.match(result, /\[error\]/);
    assert.match(result, /yolo/);
  });
});

describe("cycleYoloMode", () => {
  function makeCtx() {
    const notifications: Array<{ msg: string; type: string }> = [];
    const statuses: Array<{ id: string; text: string }> = [];
    return {
      hasUI: true,
      notifications,
      statuses,
      ui: {
        theme,
        setStatus(id: string, text: string) { statuses.push({ id, text }); },
        notify(msg: string, type: string) { notifications.push({ msg, type }); },
      },
    };
  }

  function makePi() {
    const appended: Array<{ type: string; data: unknown }> = [];
    return {
      appended,
      appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
    };
  }

  it("cycles off → writes → full → off", () => {
    const state = createYoloState();
    const pi = makePi() as any;
    const ctx = makeCtx();

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(state.mode, "writes");

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(state.mode, "full");

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(state.mode, "off");
  });

  it("appends a session entry on each cycle", () => {
    const state = createYoloState();
    const pi = makePi() as any;
    const ctx = makeCtx();

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(pi.appended.length, 1);
    assert.equal(pi.appended[0].type, YOLO_ENTRY_TYPE);
    assert.deepEqual((pi.appended[0].data as any).mode, "writes");
  });

  it("sets status bar text", () => {
    const state = createYoloState();
    const pi = makePi() as any;
    const ctx = makeCtx();

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(ctx.statuses.length, 1);
    assert.equal(ctx.statuses[0].id, "nolo");
  });

  it("sends a notification with info type", () => {
    const state = createYoloState();
    const pi = makePi() as any;
    const ctx = makeCtx();

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].type, "info");
  });

  it("does not touch UI when hasUI is false", () => {
    const state = createYoloState();
    const pi = makePi() as any;
    const ctx = { hasUI: false, ui: { theme, setStatus: () => {}, notify: () => {} } };

    cycleYoloMode(state, pi, ctx as any);
    assert.equal(state.mode, "writes"); // still cycles
  });
});

describe("scope-writes", () => {
  function makePi() {
    const appended: Array<{ type: string; data: unknown }> = [];
    return {
      appended,
      appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
    };
  }
  function makeCtx() {
    const notifications: Array<{ msg: string; type: string }> = [];
    return {
      hasUI: true,
      notifications,
      ui: { notify: (msg: string, type: string) => notifications.push({ msg, type }) },
    };
  }

  it("defaults to the value passed into createYoloState", () => {
    assert.equal(createYoloState().scopeWrites, false);
    assert.equal(createYoloState(true).scopeWrites, true);
  });

  it("toggleScopeWrites flips and persists", () => {
    const state = createYoloState(false);
    const pi = makePi() as any;
    toggleScopeWrites(state, pi, makeCtx() as any);
    assert.equal(state.scopeWrites, true);
    assert.equal(pi.appended[0].type, SCOPE_WRITES_ENTRY_TYPE);
    assert.equal((pi.appended[0].data as any).scopeWrites, true);
  });

  it("restoreScopeWrites restores from last entry", () => {
    const state = createYoloState(false);
    restoreScopeWrites(
      [{ type: "custom", customType: SCOPE_WRITES_ENTRY_TYPE, data: { scopeWrites: true } }],
      state,
    );
    assert.equal(state.scopeWrites, true);
  });

  it("restoreScopeWrites leaves default when no entry", () => {
    const state = createYoloState(true);
    restoreScopeWrites([], state);
    assert.equal(state.scopeWrites, true);
  });
});
