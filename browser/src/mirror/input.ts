import type { EngineKeyEvent, PointerEvent, WheelEvent } from "pixel-react";

type Mods = { shift: boolean; alt: boolean; ctrl: boolean; super: boolean };

export function cdpModifiers(mods: Mods): number {
  return (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.super ? 4 : 0) | (mods.shift ? 8 : 0);
}

const MOUSE_BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4 };

export function buttonMask(pressed: Iterable<string>): number {
  let mask = 0;
  for (const button of pressed) mask |= MOUSE_BUTTON_BITS[button] ?? 0;
  return mask;
}

export interface CdpMouseEvent extends Record<string, unknown> {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button: string;
  buttons: number;
  modifiers: number;
}

export function mouseEvent(
  event: PointerEvent,
  at: { x: number; y: number },
  pressed: Set<string>,
  clickCount: number,
): CdpMouseEvent {
  return {
    type:
      event.kind === "down" ? "mousePressed" : event.kind === "up" ? "mouseReleased" : "mouseMoved",
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: event.button,
    buttons: buttonMask(pressed),
    clickCount: event.kind === "move" ? 0 : clickCount,
    modifiers: cdpModifiers(event.mods),
  };
}

const WHEEL_DETENT_PX = 100;

/** the protocol takes deltas the way a page reads them, so a scroll down is positive */
export function wheelEvent(
  event: WheelEvent,
  at: { x: number; y: number },
  pressed: Set<string>,
  paneToPage: number,
): CdpMouseEvent {
  const detent = (delta: number) => Math.sign(delta) * WHEEL_DETENT_PX;
  return {
    type: "mouseWheel",
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: "none",
    buttons: buttonMask(pressed),
    modifiers: cdpModifiers(event.mods),
    deltaX: event.precise ? event.deltaX * paneToPage : detent(event.deltaX),
    deltaY: event.precise ? event.deltaY * paneToPage : detent(event.deltaY),
  };
}

interface KeyInfo {
  key: string;
  code: string;
  keyCode: number;
}

const NAMED_KEYS: Record<string, KeyInfo> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  leftshift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  rightshift: { key: "Shift", code: "ShiftRight", keyCode: 16 },
  leftcontrol: { key: "Control", code: "ControlLeft", keyCode: 17 },
  rightcontrol: { key: "Control", code: "ControlRight", keyCode: 17 },
  leftalt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  rightalt: { key: "Alt", code: "AltRight", keyCode: 18 },
  leftsuper: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  rightsuper: { key: "Meta", code: "MetaRight", keyCode: 93 },
};

const PUNCTUATION_CODES: Record<string, string> = {
  " ": "Space",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
};

export function keyInfo(key: string): KeyInfo | null {
  const named = NAMED_KEYS[key];
  if (named) return named;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (fn) return { key: key.toUpperCase(), code: key.toUpperCase(), keyCode: 111 + Number(fn[1]) };
  if ([...key].length !== 1) return null;
  const char = key;
  const upper = char.toUpperCase();
  if (upper >= "A" && upper <= "Z") {
    return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (char >= "0" && char <= "9") {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0) };
  }
  const code = PUNCTUATION_CODES[char];
  if (code) return { key: char, code, keyCode: char === " " ? 32 : char.charCodeAt(0) };
  return { key: char, code: "", keyCode: char.toUpperCase().charCodeAt(0) };
}

export interface CdpKeyEvent extends Record<string, unknown> {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  modifiers: number;
}

/** one terminal key press becomes the events a page expects to see */
export function keyEvents(event: EngineKeyEvent): CdpKeyEvent[] {
  const info = keyInfo(event.key);
  if (!info) {
    if (event.kind === "release" || !event.text) return [];
    return [{ type: "char", text: event.text, modifiers: cdpModifiers(event.mods) }];
  }
  const modifiers = cdpModifiers(event.mods);
  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    modifiers,
  };
  if (event.kind === "release") return [{ type: "keyUp", ...base }];
  const typed = event.text && !event.mods.ctrl && !event.mods.super && !event.mods.alt;
  if (!typed) {
    return [{ type: "rawKeyDown", ...base, autoRepeat: event.kind === "repeat" }];
  }
  return [
    {
      type: "keyDown",
      ...base,
      key: event.key === "enter" ? "Enter" : event.text!,
      text: event.key === "enter" ? "\r" : event.text!,
      unmodifiedText: event.key === "enter" ? "\r" : event.text!.toLowerCase(),
      autoRepeat: event.kind === "repeat",
    },
  ];
}

export function nextClickCount(
  previous: { button: string; at: number; x: number; y: number; count: number },
  button: string,
  x: number,
  y: number,
  now: number,
): number {
  const close = Math.abs(x - previous.x) <= 4 && Math.abs(y - previous.y) <= 4;
  return previous.button === button && now - previous.at <= 500 && close
    ? Math.min(previous.count + 1, 3)
    : 1;
}
