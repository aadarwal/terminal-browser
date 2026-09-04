const assert = require("node:assert/strict");
const { test } = require("node:test");

const { detachCommands } = require("../dist/mirror/cdp.js");
const { mirrorFromArgv } = require("../dist/mirror/spec.js");
const { tabOptionsIn } = require("../dist/session/tabs.js");

const SOCKET = "ws://127.0.0.1:18744/devtools/browser/91D9-46";

test("a session only mirrors when it was asked to", () => {
  assert.equal(mirrorFromArgv(["https://example.com"]), null);
  assert.equal(mirrorFromArgv([`--mirror-cdp=${SOCKET}`]), null, "an endpoint alone mirrors nothing");
});

test("the flags the cli passes describe the browser to attach to", () => {
  assert.deepEqual(mirrorFromArgv(["--mirror", `--mirror-cdp=${SOCKET}`]), {
    endpoint: { host: "127.0.0.1", port: 18744, socketUrl: SOCKET },
    targetId: null,
    newTab: false,
  });
  const pinned = mirrorFromArgv([
    "--mirror",
    "--mirror-cdp=http://127.0.0.1:9333",
    "--mirror-target=page-7",
  ]);
  assert.deepEqual(pinned.endpoint, { host: "127.0.0.1", port: 9333, socketUrl: null });
  assert.equal(pinned.targetId, "page-7");
  assert.equal(
    mirrorFromArgv(["--mirror", `--mirror-cdp=${SOCKET}`, "--mirror-new-tab"]).newTab,
    true,
  );
  // the cli settles which browser this is about, so the browser never has to guess
  assert.throws(() => mirrorFromArgv(["--mirror"]), /--mirror-cdp=/);
});

test("closing the view hands the tab back instead of closing it", () => {
  const commands = detachCommands("session-1");
  assert.deepEqual(
    commands.map((command) => command.method),
    ["Page.stopScreencast", "Target.detachFromTarget"],
  );
  assert.equal(commands[0].onSession, true, "the tab stops sending pictures");
  assert.equal(commands[1].onSession, false, "the browser is the one that lets go");
  assert.deepEqual(commands[1].params, { sessionId: "session-1" });
  for (const command of commands) {
    assert.notEqual(command.method, "Target.closeTarget");
    assert.notEqual(command.method, "Browser.close");
    assert.notEqual(command.method, "Page.close");
  }
});

test("every tab a mirroring session opens stays in the browser it mirrors", () => {
  const mirroring = mirrorFromArgv([
    "--mirror",
    `--mirror-cdp=${SOCKET}`,
    "--mirror-target=page-7",
  ]);

  const opened = tabOptionsIn(mirroring, {});
  assert.deepEqual(opened.mirror, {
    endpoint: mirroring.endpoint,
    targetId: null,
    newTab: true,
  });
  assert.equal(opened.mirror.endpoint.socketUrl, SOCKET, "the same browser, on the same socket");

  const first = tabOptionsIn(mirroring, { mirror: mirroring });
  assert.equal(first.mirror.targetId, "page-7", "the tab we were asked for keeps its target");
  assert.equal(first.mirror.newTab, false);

  const app = tabOptionsIn(mirroring, { app: { id: "notes", name: "notes" } });
  assert.equal(app.mirror, undefined, "an app tab is ours to run, not theirs");
});

test("a session that mirrors nothing opens tabs the way it always did", () => {
  assert.deepEqual(tabOptionsIn(null, {}), {});
  assert.deepEqual(tabOptionsIn(null, { partition: "work" }), { partition: "work" });
});
