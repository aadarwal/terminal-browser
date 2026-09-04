const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  browserKinds,
  browserNames,
  discoverBrowsers,
  discoverIn,
  endpointUrl,
  readActivePort,
} = require("../dist/discover.js");

function profiles(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-discover-"));
  const kinds = [];
  for (const [id, contents] of Object.entries(entries)) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (contents !== null) fs.writeFileSync(path.join(dir, "DevToolsActivePort"), contents);
    kinds.push({ id, name: id[0].toUpperCase() + id.slice(1), roots: [dir] });
  }
  return { root, kinds };
}

const alive = () => Promise.resolve(true);
const dead = () => Promise.resolve(false);

test("a browser that shares a tab publishes its port and the exact socket", () => {
  const { kinds } = profiles({ helium: "18744\n/devtools/browser/91D9-4634\n" });
  assert.deepEqual(readActivePort(kinds[0].roots[0]), {
    port: 18744,
    socketPath: "/devtools/browser/91D9-4634",
  });
});

test("anything that is not a port and a browser path is ignored", () => {
  const { kinds } = profiles({
    empty: "",
    noPath: "18744\n",
    badPort: "not-a-port\n/devtools/browser/abc\n",
    outOfRange: "70000\n/devtools/browser/abc\n",
    wrongPath: "18744\n/devtools/page/abc\n",
    injected: "18744\n/devtools/browser/abc?x=1\n",
    missing: null,
  });
  for (const kind of kinds) {
    assert.equal(readActivePort(kind.roots[0]), null, `${kind.id} should be ignored`);
  }
  assert.equal(readActivePort(path.join(os.tmpdir(), "no-such-profile-dir")), null);
});

test("a browser is only found when something still answers on its port", async () => {
  const { kinds } = profiles({ helium: "18744\n/devtools/browser/abc\n" });
  assert.deepEqual(await discoverBrowsers({ kinds, live: dead }), [], "a stale file is not a browser");
  const found = await discoverBrowsers({ kinds, live: alive });
  assert.equal(found.length, 1);
  assert.equal(found[0].browser, "helium");
  assert.equal(endpointUrl(found[0]), "ws://127.0.0.1:18744/devtools/browser/abc");
});

test("every browser sharing a tab is reported, so the caller can ask which", async () => {
  const { kinds } = profiles({
    helium: "18744\n/devtools/browser/aaa\n",
    chrome: "9222\n/devtools/browser/bbb\n",
    brave: null,
  });
  const found = await discoverBrowsers({ kinds, live: alive });
  assert.deepEqual(found.map((browser) => browser.browser), ["helium", "chrome"]);
});

test("a profile directory can be named outright", async () => {
  const { kinds } = profiles({ work: "18745\n/devtools/browser/ccc\n" });
  const found = await discoverIn(kinds[0].roots[0], { live: alive });
  assert.equal(endpointUrl(found), "ws://127.0.0.1:18745/devtools/browser/ccc");
  assert.equal(await discoverIn(path.join(os.tmpdir(), "nope"), { live: alive }), null);
});

test("the browsers we know about have a profile root on both systems we support", () => {
  for (const platform of ["darwin", "linux"]) {
    const kinds = browserKinds(platform);
    assert.deepEqual(
      kinds.map((kind) => kind.id),
      ["helium", "chrome", "chromium", "brave", "edge"],
    );
    for (const kind of kinds) {
      assert.ok(kind.roots.length > 0 && kind.roots.every(path.isAbsolute), kind.id);
    }
  }
  assert.deepEqual(browserNames(), browserKinds().map((kind) => kind.id));
});
