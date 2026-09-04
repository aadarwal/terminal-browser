const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buttonMask,
  cdpModifiers,
  keyEvents,
  keyInfo,
  mouseEvent,
  nextClickCount,
  wheelEvent,
} = require("../dist/mirror/input.js");

const noMods = { shift: false, alt: false, ctrl: false, super: false };

test("typing a letter sends the character the page should insert", () => {
  const events = keyEvents({ key: "a", kind: "press", text: "a", mods: noMods });
  assert.equal(events.length, 1);
  assert.deepEqual(
    { type: events[0].type, key: events[0].key, code: events[0].code, text: events[0].text },
    { type: "keyDown", key: "a", code: "KeyA", text: "a" },
  );
  assert.equal(events[0].windowsVirtualKeyCode, 65);
});

test("enter carries the return the page expects", () => {
  const [event] = keyEvents({ key: "enter", kind: "press", text: "\n", mods: noMods });
  assert.equal(event.type, "keyDown");
  assert.equal(event.key, "Enter");
  assert.equal(event.text, "\r");
  assert.equal(event.windowsVirtualKeyCode, 13);
});

test("a shortcut is a raw key press with no text", () => {
  const [event] = keyEvents({
    key: "c",
    kind: "press",
    text: "c",
    mods: { ...noMods, ctrl: true },
  });
  assert.equal(event.type, "rawKeyDown");
  assert.equal(event.text, undefined);
  assert.equal(event.modifiers, 2);
});

test("releases and repeats say so", () => {
  const [up] = keyEvents({ key: "escape", kind: "release", mods: noMods });
  assert.equal(up.type, "keyUp");
  assert.equal(up.key, "Escape");
  const [repeat] = keyEvents({ key: "down", kind: "repeat", mods: noMods });
  assert.equal(repeat.autoRepeat, true);
  assert.equal(repeat.code, "ArrowDown");
});

test("a key we have no name for still types its text", () => {
  const events = keyEvents({ key: "unknown", kind: "press", text: "é", mods: noMods });
  assert.deepEqual(events, [{ type: "char", text: "é", modifiers: 0 }]);
  assert.deepEqual(keyEvents({ key: "unknown", kind: "release", mods: noMods }), []);
});

test("named keys and function keys are known", () => {
  assert.deepEqual(keyInfo("pageup"), { key: "PageUp", code: "PageUp", keyCode: 33 });
  assert.deepEqual(keyInfo("f5"), { key: "F5", code: "F5", keyCode: 116 });
  assert.equal(keyInfo("leftsuper").code, "MetaLeft");
  assert.equal(keyInfo(" ").code, "Space");
});

test("modifiers use the protocol's bits", () => {
  assert.equal(cdpModifiers(noMods), 0);
  assert.equal(cdpModifiers({ shift: true, alt: true, ctrl: true, super: true }), 15);
});

test("held buttons ride along with every mouse event", () => {
  assert.equal(buttonMask(["left", "right"]), 3);
  const held = new Set(["left"]);
  const event = mouseEvent(
    { kind: "move", button: "none", mods: noMods, x: 0, y: 0 },
    { x: 12.4, y: 8.6 },
    held,
    1,
  );
  assert.deepEqual(
    { type: event.type, x: event.x, y: event.y, buttons: event.buttons, clickCount: event.clickCount },
    { type: "mouseMoved", x: 12, y: 9, buttons: 1, clickCount: 0 },
  );
});

test("a second click in the same place counts as a double click", () => {
  const first = { button: "none", at: 0, x: 0, y: 0, count: 0 };
  assert.equal(nextClickCount(first, "left", 10, 10, 1000), 1);
  const second = { button: "left", at: 1000, x: 10, y: 10, count: 1 };
  assert.equal(nextClickCount(second, "left", 11, 10, 1200), 2);
  assert.equal(nextClickCount(second, "left", 11, 10, 2000), 1, "too slow is a new click");
  assert.equal(nextClickCount(second, "left", 90, 10, 1200), 1, "too far is a new click");
});

test("scrolling is measured in the page's own pixels", () => {
  const precise = wheelEvent(
    { x: 0, y: 0, deltaX: 0, deltaY: 30, precise: true, mods: noMods },
    { x: 5, y: 5 },
    new Set(),
    2,
  );
  assert.equal(precise.type, "mouseWheel");
  assert.equal(precise.deltaY, 60);
  const ticked = wheelEvent(
    { x: 0, y: 0, deltaX: 0, deltaY: -1, precise: false, mods: noMods },
    { x: 5, y: 5 },
    new Set(),
    2,
  );
  assert.equal(ticked.deltaY, -100);
});
