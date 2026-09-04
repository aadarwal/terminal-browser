const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  backgroundBgra,
  fillsCompletely,
  fitFrame,
  insideRect,
  letterbox,
  pagePoint,
  paintBackground,
  sameRect,
} = require("../dist/mirror/frames.js");

test("a remote page keeps its shape inside the pane", () => {
  const rect = fitFrame({ width: 1000, height: 500 }, { width: 400, height: 400 });
  assert.deepEqual(rect, { x: 0, y: 100, width: 400, height: 200 });

  const tall = fitFrame({ width: 500, height: 1000 }, { width: 400, height: 400 });
  assert.deepEqual(tall, { x: 100, y: 0, width: 200, height: 400 });

  const same = fitFrame({ width: 800, height: 600 }, { width: 800, height: 600 });
  assert.deepEqual(same, { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(fillsCompletely(same, { width: 800, height: 600 }), true);
  assert.equal(fillsCompletely(rect, { width: 400, height: 400 }), false);
});

test("a pane with no room still gives a usable rect", () => {
  assert.deepEqual(fitFrame({ width: 0, height: 0 }, { width: 10, height: 10 }), {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  });
});

test("the frame lands in the middle and the bars keep the background", () => {
  const pane = { width: 4, height: 4 };
  const canvas = Buffer.alloc(pane.width * pane.height * 4);
  paintBackground(canvas, "#0000ff");
  assert.deepEqual([...canvas.subarray(0, 4)], [255, 0, 0, 255]);

  const frameSize = { width: 4, height: 2 };
  const frame = Buffer.alloc(frameSize.width * frameSize.height * 4, 0x7f);
  const rect = fitFrame(frameSize, pane);
  assert.deepEqual(rect, { x: 0, y: 1, width: 4, height: 2 });
  letterbox(frame, frameSize, rect, pane, canvas);

  const pixel = (x, y) => [...canvas.subarray((y * pane.width + x) * 4, (y * pane.width + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 0), [255, 0, 0, 255], "the bar above stays background");
  assert.deepEqual(pixel(0, 1), [0x7f, 0x7f, 0x7f, 0x7f], "the frame starts on its own row");
  assert.deepEqual(pixel(3, 2), [0x7f, 0x7f, 0x7f, 0x7f]);
  assert.deepEqual(pixel(2, 3), [255, 0, 0, 255], "the bar below stays background");
});

test("a frame wider than the pane is clipped rather than written past the end", () => {
  const pane = { width: 2, height: 2 };
  const canvas = Buffer.alloc(pane.width * pane.height * 4);
  const frameSize = { width: 4, height: 1 };
  const frame = Buffer.alloc(frameSize.width * frameSize.height * 4, 9);
  letterbox(frame, frameSize, { x: 0, y: 0, width: 4, height: 1 }, pane, canvas);
  assert.equal(canvas.length, 16);
  assert.deepEqual([...canvas.subarray(0, 8)], [9, 9, 9, 9, 9, 9, 9, 9]);
  assert.deepEqual([...canvas.subarray(8)], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("clicks land where the page thinks they did", () => {
  const rect = { x: 100, y: 0, width: 200, height: 400 };
  const page = { width: 800, height: 1600 };
  assert.deepEqual(pagePoint(100, 0, rect, page), { x: 0, y: 0 });
  assert.deepEqual(pagePoint(300, 400, rect, page), { x: 800, y: 1600 });
  assert.deepEqual(pagePoint(200, 200, rect, page), { x: 400, y: 800 });
  assert.deepEqual(pagePoint(0, 0, rect, page), { x: 0, y: 0 }, "the bars clamp into the page");
  assert.deepEqual(pagePoint(9999, 9999, rect, page), { x: 800, y: 1600 });
});

test("a background colour reads as blue green red alpha", () => {
  assert.deepEqual(backgroundBgra("#102030"), [0x30, 0x20, 0x10, 255]);
  assert.deepEqual(backgroundBgra("#fff"), [255, 255, 255, 255]);
});

test("when the page changes shape the old bars are painted over", () => {
  const pane = { width: 4, height: 4 };
  const canvas = Buffer.alloc(pane.width * pane.height * 4);
  const pixel = (x, y) => [...canvas.subarray((y * pane.width + x) * 4, (y * pane.width + x) * 4 + 4)];

  const wide = { width: 4, height: 2 };
  const wideRect = fitFrame(wide, pane);
  paintBackground(canvas, "#000000");
  letterbox(Buffer.alloc(wide.width * wide.height * 4, 8), wide, wideRect, pane, canvas);
  assert.deepEqual(pixel(0, 1), [8, 8, 8, 8]);

  const tall = { width: 2, height: 4 };
  const tallRect = fitFrame(tall, pane);
  assert.equal(sameRect(wideRect, tallRect), false, "a new shape means new bars");
  assert.equal(sameRect(tallRect, { ...tallRect }), true);
  paintBackground(canvas, "#000000");
  letterbox(Buffer.alloc(tall.width * tall.height * 4, 3), tall, tallRect, pane, canvas);
  assert.deepEqual(pixel(0, 1), [0, 0, 0, 255], "nothing of the wide frame is left over");
  assert.deepEqual(pixel(1, 1), [3, 3, 3, 3]);
});

test("the bars around the page are not part of the page", () => {
  const rect = { x: 1, y: 0, width: 2, height: 4 };
  assert.equal(insideRect(rect, 1, 0), true);
  assert.equal(insideRect(rect, 2, 3), true);
  assert.equal(insideRect(rect, 0, 0), false, "a click left of the page is on a bar");
  assert.equal(insideRect(rect, 3, 0), false);
  assert.equal(insideRect(rect, 1, 4), false);
});
