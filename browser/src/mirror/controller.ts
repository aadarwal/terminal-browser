import { nativeImage } from "electron";
import type { DevtoolsDock } from "pixel-store";
import type {
  EngineKeyEvent,
  PastedImage,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";

import type { DevtoolsAction, DevtoolsWindow } from "../page/devtools";
import type { MirrorTarget, PageController } from "../page/page-controller";
import type { PopupWindow } from "../page/popup";
import { initialBrowserState } from "../page/types";
import type { BrowserState, BrowserSurfaceLayout } from "../page/types";
import { normalizeUrl } from "../url";
import { detachCommands, endpointLabel, leaseConnection, pickTarget } from "./cdp";
import type { CdpConnection, CdpEndpoint, ConnectionLease } from "./cdp";
import {
  fillsCompletely,
  fitFrame,
  insideRect,
  letterbox,
  paintBackground,
  pagePoint,
  sameRect,
} from "./frames";
import type { FitRect, Size } from "./frames";
import { keyEvents, mouseEvent, nextClickCount, wheelEvent } from "./input";

export interface MirrorOptions {
  endpoint: CdpEndpoint;
  targetId: string | null;
  newTab: boolean;
  url: string | null;
  cwd: string;
  background: string;
  visible: boolean;
}

interface NavigationHistory {
  currentIndex: number;
  entries: { id: number; url: string; title: string }[];
}

interface ScreencastMetadata {
  deviceWidth?: number;
  deviceHeight?: number;
}

/** draws a tab that lives in a browser we did not start, and leaves it running when we let go */
export class MirrorController implements PageController {
  readonly surface: Surface;
  readonly popup: PopupWindow | null = null;
  devtools: DevtoolsWindow | null = null;
  devtoolsFocused = false;
  cursorShape = "default";
  onFrameSubmitted: (() => void) | null = null;
  onCursorChange: ((shape: string) => void) | null = null;
  onOpenTab: ((url: string, activate: boolean) => void) | null = null;
  onPopupChange: (() => void) | null = null;
  onDevtoolsChange: (() => void) | null = null;
  onDevtoolsAction: ((action: DevtoolsAction) => void) | null = null;
  onContextMenu: ((params: Electron.ContextMenuParams) => void) | null = null;
  onClosed: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private readonly options: MirrorOptions;
  private readonly onState: (state: BrowserState) => void;
  private readonly emitHandlers = new Map<string, (data: unknown) => void>();
  private readonly cdpEventHandlers = new Map<string, (params: unknown) => void>();
  private connection: CdpConnection | null = null;
  private lease: ConnectionLease | null = null;
  private readonly subscribed = new Set<string>();
  private readonly listening: { sessionId: string | null; method: string; handler: (params: unknown) => void }[] = [];
  private forgetClose: (() => void) | null = null;
  private sessionId: string | null = null;
  private pinnedTarget: string | null = null;
  private ready: Promise<void> | null = null;
  private layout: BrowserSurfaceLayout;
  private state: BrowserState;
  private background: string;
  private visible: boolean;
  private stopped = false;
  private casting = false;
  private lastFrame: Size | null = null;
  private page: Size | null = null;
  private rect: FitRect | null = null;
  private canvas: Buffer | null = null;
  private canvasSize: Size | null = null;
  private painted: FitRect | null = null;
  private pressed = new Set<string>();
  private click = { button: "none", at: 0, x: 0, y: 0, count: 0 };
  private pointerAt = { x: 0, y: 0 };

  constructor(
    surface: Surface,
    layout: BrowserSurfaceLayout,
    options: MirrorOptions,
    onState: (state: BrowserState) => void,
  ) {
    this.surface = surface;
    this.layout = layout;
    this.options = options;
    this.background = options.background;
    this.visible = options.visible;
    this.onState = onState;
    this.state = initialBrowserState(options.url ?? "");
    this.onState(this.state);
    void this.attachCdp().catch((error: unknown) => {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      this.onError?.(message);
      this.onClosed?.();
    });
  }

  get mirror(): MirrorTarget | null {
    return this.pinnedTarget
      ? { endpoint: endpointLabel(this.options.endpoint), targetId: this.pinnedTarget }
      : null;
  }

  attachCdp(): Promise<void> {
    this.ready ??= this.connect();
    return this.ready;
  }

  private async connect(): Promise<void> {
    const lease = await leaseConnection(this.options.endpoint);
    const connection = lease.connection;
    this.lease = lease;
    if (this.gaveUp(connection, null)) return;
    this.connection = connection;
    this.forgetClose = connection.onClosed(() => this.remoteGone());
    const targetId = await this.resolveTarget(connection);
    if (this.gaveUp(connection, null)) return;
    this.pinnedTarget = targetId;
    const attached = (await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (!attached.sessionId) throw new Error(`could not attach to tab ${targetId}`);
    if (this.gaveUp(connection, attached.sessionId)) return;
    this.sessionId = attached.sessionId;
    this.listen(null, "Target.detachedFromTarget", (params) => {
      const detached = params as { sessionId?: string };
      if (detached.sessionId === this.sessionId) this.remoteGone();
    });
    this.listen(null, "Target.targetInfoChanged", (params) => {
      const info = (params as { targetInfo?: { targetId?: string; url?: string; title?: string } })
        .targetInfo;
      if (!info || info.targetId !== this.pinnedTarget) return;
      this.updateState({ url: info.url ?? this.state.url, title: info.title ?? this.state.title });
    });
    await connection.send("Target.setDiscoverTargets", { discover: true });
    await this.session("Page.enable");
    await this.session("Runtime.enable");
    await this.session("Runtime.addBinding", { name: "__pixelEmit" });
    this.listen(this.sessionId, "Runtime.bindingCalled", (params) => this.binding(params));
    this.listen(this.sessionId, "Page.screencastFrame", (params) => this.frame(params));
    for (const method of PAGE_EVENTS) {
      this.subscribed.add(method);
      this.listen(this.sessionId, method, (params) => {
        this.cdpEventHandlers.get(method)?.(params);
        void this.readPage();
      });
    }
    for (const method of this.cdpEventHandlers.keys()) this.subscribe(method);
    if (this.gaveUp(connection, this.sessionId)) return;
    if (this.options.url && !this.options.newTab) {
      await this.session("Page.navigate", { url: normalizeUrl(this.options.url, this.options.cwd) });
    }
    await this.readPage();
    if (this.visible) await this.startCast();
  }

  /** the pane can close while we are still connecting, and the tab must survive that */
  private gaveUp(connection: CdpConnection, sessionId: string | null): boolean {
    if (!this.stopped) return false;
    this.connection = null;
    this.sessionId = null;
    this.unlisten(connection);
    void this.letGo(connection, sessionId).then(() => this.releaseConnection());
    return true;
  }

  private async resolveTarget(connection: CdpConnection): Promise<string> {
    if (this.options.newTab) {
      const created = (await connection.send("Target.createTarget", {
        url: this.options.url ? normalizeUrl(this.options.url, this.options.cwd) : "about:blank",
      })) as { targetId?: string };
      if (!created.targetId) throw new Error("that browser would not open a tab");
      return created.targetId;
    }
    // asked over this connection, because a browser that asks for permission serves no http
    return pickTarget(await connection.targets(), this.options.targetId).id;
  }

  private session(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = this.connection;
    if (!connection || !this.sessionId) {
      return Promise.reject(new Error("not attached to the mirrored tab"));
    }
    return connection.send(method, params, this.sessionId);
  }

  private async startCast(): Promise<void> {
    if (this.stopped || this.casting || !this.sessionId) return;
    this.casting = true;
    await this.session("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: Math.max(1, Math.round(this.layout.width)),
      maxHeight: Math.max(1, Math.round(this.layout.height)),
    }).catch(() => {
      this.casting = false;
    });
  }

  private async stopCast(): Promise<void> {
    if (!this.casting) return;
    this.casting = false;
    await this.session("Page.stopScreencast").catch(() => {});
  }

  private frame(params: unknown): void {
    const frame = params as {
      data?: string;
      sessionId?: number;
      metadata?: ScreencastMetadata;
    };
    if (frame.sessionId !== undefined) {
      void this.session("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    }
    if (this.stopped || !frame.data) return;
    const image = nativeImage.createFromBuffer(Buffer.from(frame.data, "base64"));
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return;
    const pane = this.paneSize();
    const rect = fitFrame(size, pane);
    this.lastFrame = size;
    this.rect = rect;
    this.page = {
      width: frame.metadata?.deviceWidth ?? size.width,
      height: frame.metadata?.deviceHeight ?? size.height,
    };
    if (fillsCompletely(rect, pane) && size.width === pane.width && size.height === pane.height) {
      this.surface.present({ bgra: image.toBitmap(), width: pane.width, height: pane.height });
    } else {
      const fitted =
        size.width === rect.width && size.height === rect.height
          ? image
          : image.resize({ width: rect.width, height: rect.height });
      const canvas = this.canvasFor(pane, rect);
      this.surface.present({
        bgra: letterbox(fitted.toBitmap(), fitted.getSize(), rect, pane, canvas),
        width: pane.width,
        height: pane.height,
      });
    }
    this.onFrameSubmitted?.();
  }

  private canvasFor(pane: Size, rect: FitRect): Buffer {
    const resized =
      !this.canvas ||
      this.canvasSize?.width !== pane.width ||
      this.canvasSize?.height !== pane.height;
    if (resized) {
      this.canvas = Buffer.alloc(pane.width * pane.height * 4);
      this.canvasSize = pane;
    }
    // when the page changes shape the bars move, so the old picture has to go
    if (resized || !sameRect(this.painted, rect)) {
      paintBackground(this.canvas!, this.background);
      this.painted = rect;
    }
    return this.canvas!;
  }

  private paneSize(): Size {
    return {
      width: Math.max(1, Math.round(this.layout.width)),
      height: Math.max(1, Math.round(this.layout.height)),
    };
  }

  private binding(params: unknown): void {
    const call = params as { name?: string; payload?: string };
    if (call.name !== "__pixelEmit" || !call.payload) return;
    try {
      const message = JSON.parse(call.payload) as { channel: string; data: unknown };
      this.emitHandlers.get(message.channel)?.(message.data);
    } catch {}
  }

  private async readPage(): Promise<void> {
    const history = await this.history();
    if (!history) return;
    const at = history.entries[history.currentIndex];
    if (!at) return;
    this.updateState({
      url: at.url,
      title: at.title || this.state.title,
      loading: false,
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
    });
  }

  private async history(): Promise<NavigationHistory | null> {
    const reply = (await this.session("Page.getNavigationHistory").catch(() => null)) as {
      currentIndex?: number;
      entries?: { id: number; url: string; title: string }[];
    } | null;
    if (!reply?.entries) return null;
    return { currentIndex: reply.currentIndex ?? 0, entries: reply.entries };
  }

  /** the tab went away on its own, or the browser did */
  private remoteGone(): void {
    if (this.stopped) return;
    const connection = this.connection;
    this.connection = null;
    this.sessionId = null;
    if (connection) this.unlisten(connection);
    this.stop();
    this.onClosed?.();
  }

  private updateState(update: Partial<BrowserState>): void {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  resize(layout: BrowserSurfaceLayout, options?: { keepFrame?: boolean }): void {
    if (this.stopped) return;
    if (
      this.layout.width === layout.width &&
      this.layout.height === layout.height &&
      this.layout.scale === layout.scale
    ) {
      return;
    }
    this.layout = layout;
    this.canvas = null;
    if (!options?.keepFrame) this.surface.clear();
    void this.restartCast();
  }

  private async restartCast(): Promise<void> {
    if (!this.visible || this.stopped) return;
    await this.stopCast();
    await this.startCast();
  }

  navigate(value: string): void {
    void this.session("Page.navigate", { url: normalizeUrl(value, this.options.cwd) }).catch(
      () => {},
    );
  }

  back(): void {
    void this.step(-1);
  }

  forward(): void {
    void this.step(1);
  }

  private async step(by: number): Promise<void> {
    const history = await this.history();
    const entry = history?.entries[history.currentIndex + by];
    if (!entry) return;
    await this.session("Page.navigateToHistoryEntry", { entryId: entry.id }).catch(() => {});
    await this.readPage();
  }

  reload(): void {
    void this.session("Page.reload").catch(() => {});
  }

  zoom(): number {
    return this.state.zoom;
  }

  scaleZoom(): number {
    return this.state.zoom;
  }

  async fingerprint(): Promise<number | null> {
    const result = (await this.session("Runtime.evaluate", {
      expression: "performance.timeOrigin",
      returnByValue: true,
    }).catch(() => null)) as { result?: { value?: number } } | null;
    return typeof result?.result?.value === "number" ? result.result.value : null;
  }

  async targetId(): Promise<string | null> {
    await this.attachCdp().catch(() => {});
    return this.pinnedTarget;
  }

  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.session(method, params);
  }

  setBackground(background: string): Promise<void> {
    this.background = background;
    this.canvas = null;
    return Promise.resolve();
  }

  onEmit(channel: string, handler: ((data: unknown) => void) | null): void {
    if (handler) this.emitHandlers.set(channel, handler);
    else this.emitHandlers.delete(channel);
  }

  onCdpEvent(method: string, handler: ((params: unknown) => void) | null): void {
    if (!handler) {
      this.cdpEventHandlers.delete(method);
      return;
    }
    this.cdpEventHandlers.set(method, handler);
    this.subscribe(method);
  }

  private subscribe(method: string): void {
    if (!this.connection || !this.sessionId || this.subscribed.has(method)) return;
    this.subscribed.add(method);
    this.listen(this.sessionId, method, (params) => this.cdpEventHandlers.get(method)?.(params));
  }

  /** the connection outlives this view when other panes share it, so we take our handlers back */
  private listen(
    sessionId: string | null,
    method: string,
    handler: (params: unknown) => void,
  ): void {
    this.connection?.on(sessionId, method, handler);
    this.listening.push({ sessionId, method, handler });
  }

  pinFrameRate(): void {}

  async runJs(source: string): Promise<unknown> {
    const result = (await this.session("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "page threw");
    return result.result?.value;
  }

  // the page belongs to the other browser, so these are its own to offer, not ours
  find(): void {}
  findNext(): void {}
  stopFind(): void {}

  focusContent(): Promise<void> | undefined {
    return undefined;
  }

  blurContent(): void {}
  openDevtools(_layout: BrowserSurfaceLayout, _dock: DevtoolsDock): void {}
  closeDevtools(): void {}
  focusDevtools(): void {}
  blurDevtools(): void {}
  inspect(): void {}

  async selectionText(): Promise<string> {
    const text = await this.runJs("String(getSelection() ?? '')").catch(() => "");
    return typeof text === "string" ? text : "";
  }

  pointer(event: PointerEvent): void {
    if (this.stopped || !this.rect) return;
    if (event.kind === "down" && !insideRect(this.rect, event.x, event.y)) return;
    const at = this.pageAt(event.x, event.y);
    if (!at) return;
    this.pointerAt = at;
    if (event.kind === "down" && event.button !== "none") {
      this.pressed.add(event.button);
      this.click = {
        button: event.button,
        at: Date.now(),
        x: at.x,
        y: at.y,
        count: nextClickCount(this.click, event.button, at.x, at.y, Date.now()),
      };
    }
    if (event.kind === "up" && event.button !== "none") this.pressed.delete(event.button);
    const sent = mouseEvent(event, at, this.pressed, this.click.count);
    void this.session("Input.dispatchMouseEvent", sent).catch(() => {});
  }

  wheel(event: WheelEvent): void {
    if (this.stopped) return;
    const at = this.pageAt(event.x, event.y) ?? this.pointerAt;
    const sent = wheelEvent(event, at, this.pressed, this.paneToPage());
    void this.session("Input.dispatchMouseEvent", sent).catch(() => {});
  }

  key(event: EngineKeyEvent): void {
    if (this.stopped) return;
    for (const sent of keyEvents(event)) {
      void this.session("Input.dispatchKeyEvent", sent).catch(() => {});
    }
  }

  private paneToPage(): number {
    if (!this.rect || !this.page || this.rect.width <= 0) return 1;
    return this.page.width / this.rect.width;
  }

  private pageAt(x: number, y: number): { x: number; y: number } | null {
    if (!this.rect || !this.page) return null;
    return pagePoint(x, y, this.rect, this.page);
  }

  sendToPage(): void {}

  hasContents(): boolean {
    return false;
  }

  paste(text: string): void {
    void this.session("Input.insertText", { text }).catch(() => {});
  }

  pasteImage(_image: PastedImage): void {}

  setActive(active: boolean): void {
    if (active) return;
    this.pressed.clear();
  }

  setVisible(visible: boolean): void {
    if (this.stopped || this.visible === visible) return;
    this.visible = visible;
    if (visible) void this.startCast();
    else void this.stopCast();
  }

  frameSize(): Size | null {
    return this.lastFrame;
  }

  invalidate(): void {
    this.canvas = null;
    void this.restartCast();
  }

  /** letting go of the view never closes the tab we borrowed */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const connection = this.connection;
    const sessionId = this.sessionId;
    this.connection = null;
    this.sessionId = null;
    this.surface.close();
    if (!connection) {
      this.releaseConnection();
      return;
    }
    this.unlisten(connection);
    void this.letGo(connection, sessionId).then(() => this.releaseConnection());
  }

  private unlisten(connection: CdpConnection): void {
    this.forgetClose?.();
    this.forgetClose = null;
    for (const { sessionId, method, handler } of this.listening.splice(0)) {
      connection.off(sessionId, method, handler);
    }
  }

  private releaseConnection(): void {
    this.lease?.release();
    this.lease = null;
  }

  private async letGo(connection: CdpConnection, sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    for (const command of detachCommands(sessionId)) {
      await connection
        .send(command.method, command.params, command.onSession ? sessionId : undefined)
        .catch(() => {});
    }
  }
}

const PAGE_EVENTS = [
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.loadEventFired",
];
