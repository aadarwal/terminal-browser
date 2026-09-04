import type { DevtoolsDock } from "pixel-store";
import type {
  EngineKeyEvent,
  PastedImage,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";

import type { DevtoolsAction, DevtoolsWindow } from "./devtools";
import type { PopupWindow } from "./popup";
import type { BrowserState, BrowserSurfaceLayout } from "./types";
import type { ZoomDirection } from "./zoom";

export interface MirrorTarget {
  endpoint: string;
  targetId: string;
}

/** what a tab needs from whatever draws its page, whether that is our own window or a mirrored one */
export interface PageController {
  readonly surface: Surface;
  readonly popup: PopupWindow | null;
  readonly mirror: MirrorTarget | null;
  devtools: DevtoolsWindow | null;
  devtoolsFocused: boolean;
  cursorShape: string;
  onFrameSubmitted: (() => void) | null;
  onCursorChange: ((shape: string) => void) | null;
  onOpenTab: ((url: string, activate: boolean) => void) | null;
  onPopupChange: (() => void) | null;
  onDevtoolsChange: (() => void) | null;
  onDevtoolsAction: ((action: DevtoolsAction) => void) | null;
  onContextMenu: ((params: Electron.ContextMenuParams) => void) | null;
  onClosed: (() => void) | null;

  resize(layout: BrowserSurfaceLayout, options?: { keepFrame?: boolean }): void;
  navigate(value: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  zoom(direction: ZoomDirection): number;
  scaleZoom(ratio: number): number;
  fingerprint(): Promise<number | null>;
  targetId(): Promise<string | null>;
  attachCdp(): Promise<void>;
  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  setBackground(background: string): Promise<void>;
  onEmit(channel: string, handler: ((data: unknown) => void) | null): void;
  onCdpEvent(method: string, handler: ((params: unknown) => void) | null): void;
  pinFrameRate(pinned: boolean): void;
  runJs(source: string): Promise<unknown>;
  find(text: string): void;
  findNext(forward: boolean): void;
  stopFind(): void;
  focusContent(): Promise<void> | undefined;
  blurContent(): void;
  openDevtools(layout: BrowserSurfaceLayout, dock: DevtoolsDock): void;
  closeDevtools(): void;
  focusDevtools(): void;
  blurDevtools(): void;
  inspect(x: number, y: number): void;
  selectionText(): Promise<string>;
  pointer(event: PointerEvent): void;
  wheel(event: WheelEvent): void;
  key(event: EngineKeyEvent): void;
  sendToPage(channel: string, payload: unknown): void;
  hasContents(id: number): boolean;
  paste(text: string): void;
  pasteImage(image: PastedImage): void;
  setActive(active: boolean): void;
  setVisible(visible: boolean): void;
  frameSize(): { width: number; height: number } | null;
  invalidate(): void;
  stop(): void;
}

export type PageStateListener = (state: BrowserState) => void;
