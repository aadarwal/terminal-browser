const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { AGENT_SOCKETS_DIR, tabMarkProperty } = require("pixel-store");
const { agentError, findMarkedTab, probeOrder, sessionName } = require("../dist/action.js");

const browser = { key: "41587-1", pid: 41587, socket: "/tmp/41587-1.sock" };
const mirrored = {
  id: 1,
  url: "https://example.com/app",
  title: "app",
  active: true,
  targetId: "91D9463409687A80B91024B5B5F80333",
  mirror: { endpoint: "http://127.0.0.1:18744", targetId: "91D9463409687A80B91024B5B5F80333" },
};
const own = { ...mirrored, mirror: null };

// agent-browser numbers tabs t1, t2, t3, so a cdp target id never appears in its listing
const agentView = [
  { tabId: "t1", url: "https://example.com/app", title: "app", active: true },
  { tabId: "t2", url: "https://example.com/app", title: "app", active: false },
  { tabId: "t3", url: "https://other.example", title: "other", active: false },
];

test("the mirrored tab is the one carrying our mark, not the one with the same url", () => {
  const asked = [];
  const found = findMarkedTab(agentView, mirrored.url, (tabId) => {
    asked.push(tabId);
    return tabId === "t2";
  });
  assert.equal(found.tabId, "t2");
  assert.equal(found.active, true);
  assert.deepEqual(asked, ["t1", "t2"], "tabs on the same url are asked first, then it stops");
});

test("no mark means no tab, rather than a guess from the url", () => {
  assert.equal(findMarkedTab(agentView, mirrored.url, () => false), null);
  assert.equal(
    findMarkedTab(agentView, mirrored.url, () => "true"),
    null,
    "another caller's leftover value is not our mark",
  );
});

test("a tab that cannot be read is skipped, not chosen", () => {
  const found = findMarkedTab(agentView, mirrored.url, (tabId) =>
    tabId === "t3" ? true : undefined,
  );
  assert.equal(found.tabId, "t3");
  assert.deepEqual(probeOrder(agentView, mirrored.url).map((tab) => tab.tabId), [
    "t1",
    "t2",
    "t3",
  ]);
});

test("two callers asking at once mark the page under their own names", () => {
  assert.notEqual(tabMarkProperty("aaaa"), tabMarkProperty("bbbb"));
  assert.match(tabMarkProperty("aaaa"), /^__terminalBrowserTab_aaaa$/);
});

test("a mirror session name fits in a unix socket path", () => {
  const name = sessionName(browser, mirrored);
  assert.notEqual(name, sessionName(browser, own));
  assert.match(name, /^tbm-[0-9a-f]{12}$/);
  // macos refuses socket paths of 104 bytes or more, and agent-browser decorates the name
  const socket = path.join(AGENT_SOCKETS_DIR, `${name}.sock`);
  assert.ok(socket.length < 96, `${socket} is ${socket.length} bytes`);
  assert.equal(
    sessionName(browser, {
      ...mirrored,
      mirror: { ...mirrored.mirror, endpoint: "http://127.0.0.1:19000" },
    }) === name,
    false,
    "two mirrored browsers are two sessions",
  );
});

test("our own tabs keep the session name they always had", () => {
  assert.equal(sessionName(browser, own), "terminal-browser-41587-1");
});

test("what agent-browser said went wrong is what we repeat", () => {
  assert.equal(agentError('{"ok":false,"error":"socket path too long"}'), "socket path too long");
  assert.equal(agentError("not json at all\n"), "not json at all");
  assert.equal(agentError(""), "");
});
