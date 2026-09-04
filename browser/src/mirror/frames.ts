export interface Size {
  width: number;
  height: number;
}

export interface FitRect extends Size {
  x: number;
  y: number;
}

/** the remote page keeps its own shape, so it sits centred in whatever room the pane has */
export function fitFrame(frame: Size, into: Size): FitRect {
  if (frame.width <= 0 || frame.height <= 0 || into.width <= 0 || into.height <= 0) {
    return { x: 0, y: 0, width: Math.max(0, into.width), height: Math.max(0, into.height) };
  }
  const scale = Math.min(into.width / frame.width, into.height / frame.height);
  const width = Math.max(1, Math.min(into.width, Math.round(frame.width * scale)));
  const height = Math.max(1, Math.min(into.height, Math.round(frame.height * scale)));
  return {
    x: Math.floor((into.width - width) / 2),
    y: Math.floor((into.height - height) / 2),
    width,
    height,
  };
}

export function sameRect(a: FitRect | null, b: FitRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function insideRect(rect: FitRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

export function fillsCompletely(rect: FitRect, into: Size): boolean {
  return rect.x === 0 && rect.y === 0 && rect.width === into.width && rect.height === into.height;
}

export function backgroundBgra(background: string): [number, number, number, number] {
  const hex = background.replace("#", "");
  const value = Number.parseInt(hex.length === 3 ? hex.replace(/./g, "$&$&") : hex, 16);
  if (!Number.isFinite(value)) return [0, 0, 0, 255];
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, 255];
}

/** copies a decoded frame into a pane sized buffer, leaving the bars around it alone */
export function letterbox(
  frame: Buffer,
  frameSize: Size,
  rect: FitRect,
  into: Size,
  canvas: Buffer,
): Buffer {
  const rows = Math.min(rect.height, frameSize.height, into.height - rect.y);
  const columns = Math.min(rect.width, frameSize.width, into.width - rect.x);
  const rowBytes = columns * 4;
  for (let row = 0; row < rows; row++) {
    const from = row * frameSize.width * 4;
    const to = ((rect.y + row) * into.width + rect.x) * 4;
    frame.copy(canvas, to, from, from + rowBytes);
  }
  return canvas;
}

export function paintBackground(canvas: Buffer, background: string): void {
  const [b, g, r, a] = backgroundBgra(background);
  for (let at = 0; at < canvas.length; at += 4) {
    canvas[at] = b;
    canvas[at + 1] = g;
    canvas[at + 2] = r;
    canvas[at + 3] = a;
  }
}

/** pane pixels back to the css pixels the remote page thinks in */
export function pagePoint(
  x: number,
  y: number,
  rect: FitRect,
  page: Size,
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? page.width / rect.width : 1;
  const scaleY = rect.height > 0 ? page.height / rect.height : 1;
  return {
    x: clamp((x - rect.x) * scaleX, 0, page.width),
    y: clamp((y - rect.y) * scaleY, 0, page.height),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
