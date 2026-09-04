const assert = require("node:assert/strict");
const { test } = require("node:test");

const { detachCommands } = require("../dist/mirror/cdp.js");
const { mirrorFromArgv } = require("../dist/mirror/spec.js");
const { tabOptionsIn } = require("../dist/session/tabs.js");

test("a session only mirrors when it was asked to", () => {
  assert.equal(mirrorFromArgv(["https://example.com"]), null);
  assert.equal(mirrorFromArgv(["--mirror-port=9222"]), null, "a port alone mirrors nothing");
});

test("the flags the cli passes describe the browser to attach to", () => {
  assert.deepEqual(mirrorFromArgv(["--mirror", "--mirror-port=9222"]), {
    endpoint: { host: "127.0.0.1", port: 9222, origin: "http://127.0.0.1:9222" },
    targetId: null,
    newTab: false,
  });
  const pinned = mirrorFromArgv(["--mirror", "--mirror-port=9333", "--mirror-target=page-7"]);
  assert.equal(pinned.endpoint.origin, "http://127.0.0.1:9333");
  assert.equal(pinned.targetId, "page-7");
  assert.equal(mirrorFromArgv(["--mirror", "--mirror-new-tab"]).newTab, true);
  assert.equal(mirrorFromArgv(["--mirror"]).endpoint.port, 9222, "9222 is the default port");
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
  const mirroring = mirrorFromArgv(["--mirror", "--mirror-port=9333", "--mirror-target=page-7"]);

  const opened = tabOptionsIn(mirroring, {});
  assert.deepEqual(opened.mirror, {
    endpoint: mirroring.endpoint,
    targetId: null,
    newTab: true,
  });
  assert.equal(opened.mirror.endpoint.port, 9333, "the same browser, on the same port");

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
