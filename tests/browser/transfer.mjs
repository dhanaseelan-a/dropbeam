// Browser-level UI/lifecycle regression checks. PeerJS is substituted with an
// ordered in-memory channel; these tests do NOT certify real ICE/TURN or carriers.
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import JSZip from "jszip";
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = process.env.DROPBEAM_SOURCE_ROOT || testRoot;
const vite = await createServer({
  root,
  resolve: { alias: { peerjs: join(testRoot, "tests/browser/peerStub.js") } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: executablePath
    ? [
        "--no-sandbox",
        "--no-zygote",
        "--in-process-gpu",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ]
    : [],
});
const fixtureDir = await mkdtemp(join(tmpdir(), "dropbeam-folder-"));
const sharedContext = await browser.newContext({ acceptDownloads: true });
const errors = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function page() {
  const context = sharedContext;
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log("BROWSER", m.type(), m.text());
  });
  await p.route("**/api/ice-servers", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ iceServers: [{ urls: "stun:127.0.0.1:9" }] }),
    }),
  );
  await p.addInitScript(() => {
    window.__pcs = [];
    window.__rxBytes = 0;
    window.__sentBytes = 0;
    window.__controls = [];
  });
  return p;
}
const files = [
  { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
  {
    name: "first.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(100003, 42),
  },
  {
    name: "second.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(
      Uint8Array.from({ length: 6 * 1024 * 1024 + 57 }, (_, i) => i % 251),
    ),
  },
];
async function senderWithFiles(selected = files) {
  const s = await page();
  await s.goto(origin);
  await s.locator("input[type=file]").setInputFiles(selected);
  await s.locator(".code-value").waitFor();
  const code = (await s.locator(".code-value").innerText()).trim();
  return { s, code };
}
async function receiver(code) {
  const r = await page();
  const downloads = [];
  r.on("download", (d) => downloads.push(d));
  await r.goto(origin + "/?code=" + code);
  return { r, downloads };
}
async function verifyDownloads(downloads, expected = files) {
  assert.equal(downloads.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(downloads[i].suggestedFilename(), expected[i].name);
    assert.equal(
      hash(await readFile(await downloads[i].path())),
      hash(expected[i].buffer),
    );
  }
}
try {
  const { s, code } = await senderWithFiles();
  assert.equal(await s.locator(".qr-code").count(), 1);
  await s.evaluate(() => {
    window.__chunkLimit = 16384;
    window.__failBinaryOnce = true;
  });
  const { r, downloads } = await receiver(code);
  await r.locator(".complete-title").waitFor({ timeout: 30000 });
  await s.locator(".complete-title").waitFor({ timeout: 30000 });
  await verifyDownloads(downloads);
  console.log(
    "PASS: browser hooks with simulated channels, 16 KB message limit, full queue retry, multi-file integrity, empty file, QR, completion",
  );
  await s.close();
  await r.close();

  const pair = await senderWithFiles();
  await pair.s.evaluate(() => {
    window.__slow = true;
  });
  const a = await receiver(pair.code);
  const b = await receiver(pair.code);
  await a.r.waitForFunction(() => window.__rxBytes > 800000);
  await a.r.evaluate(() => { window.__failControls = ['pause', 'resume']; });
  await a.r.getByRole("button", { name: "⏸ Pause", exact: true }).click();
  await a.r.locator(".pause-banner").waitFor();
  await pair.s.locator(".remote-pause-banner").waitFor({ timeout: 3000 });
  await a.r.waitForTimeout(200);
  const pausedBytes = await a.r.evaluate(() => window.__rxBytes);
  const otherBytes = await b.r.evaluate(() => window.__rxBytes);
  await a.r.waitForTimeout(400);
  assert.equal(await a.r.evaluate(() => window.__rxBytes), pausedBytes, 'paused receiver must stop receiving bytes');
  assert.ok(await b.r.evaluate(() => window.__rxBytes) > otherBytes, 'other receiver must keep transferring');
  await a.r.getByRole("button", { name: "▶ Resume", exact: true }).click();
  await a.r.waitForFunction(previous => window.__rxBytes > previous + 65536, pausedBytes, { timeout: 3000 });
  await a.r.evaluate(() => window.__pcs.at(-1).close());
  await a.r
    .getByText("Connection interrupted — reconnecting...")
    .waitFor({ timeout: 5000 });
  assert.equal(
    (await pair.s.locator(".code-value").innerText()).trim(),
    pair.code,
  );
  await a.r.locator(".complete-title").waitFor({ timeout: 60000 });
  await b.r.locator(".complete-title").waitFor({ timeout: 60000 });
  await pair.s.locator(".complete-title").waitFor({ timeout: 60000 });
  await verifyDownloads(a.downloads);
  await verifyDownloads(b.downloads);
  const handshakes = await a.r.evaluate(() =>
    window.__controls.filter((m) => m.type === "device-info"),
  );
  assert.ok(handshakes.length > 1);
  assert.ok(handshakes[1].resumeIndex === 2);
  assert.ok(handshakes[1].resumeOffset > 0);
  assert.equal(
    (await pair.s.locator(".code-value").count())
      ? (await pair.s.locator(".code-value").innerText()).trim()
      : pair.code,
    pair.code,
  );
  assert.equal(await pair.s.locator(".receiver-card").count(), 2);
  console.log(
    "PASS: two identical-device receivers, receiver pause/resume, disconnect during second nonempty file, exact resume, no duplicate downloads",
  );
  await pair.s.getByRole("button", { name: "Send more files" }).click();
  await pair.s
    .getByRole("button", { name: "Select Files", exact: true })
    .waitFor();
  await a.r.getByRole("button", { name: "Receive more files" }).click();
  await a.r.locator(".code-input").waitFor();
  console.log("PASS: send-more and receive-more reset controls");

  await mkdir(join(fixtureDir, "nested"), { recursive: true });
  await writeFile(join(fixtureDir, "hello.txt"), "Folder contents preserved");
  await writeFile(join(fixtureDir, "nested/empty.txt"), "");
  const chooserPromise = pair.s.waitForEvent("filechooser");
  await pair.s
    .getByRole("button", { name: "Select Folder", exact: true })
    .click();
  await (await chooserPromise).setFiles(fixtureDir);
  await pair.s.locator(".code-value").waitFor();
  const folderReceiver = await receiver(
    (await pair.s.locator(".code-value").innerText()).trim(),
  );
  await folderReceiver.r.locator(".complete-title").waitFor();
  const zip = await JSZip.loadAsync(
    await readFile(await folderReceiver.downloads[0].path()),
  );
  assert.equal(
    await zip.file("hello.txt").async("string"),
    "Folder contents preserved",
  );
  assert.equal(await zip.file("nested/empty.txt").async("string"), "");
  console.log("PASS: folder picker, ZIP generation and nested file contents");
  const cancelPair = await senderWithFiles([files[2]]);
  await cancelPair.s.evaluate(() => {
    window.__slow = true;
  });
  const cancelReceiver = await receiver(cancelPair.code);
  await cancelReceiver.r.waitForFunction(() => window.__rxBytes > 200000);
  await cancelPair.s.evaluate(() => { window.__failControls = ['pause', 'resume']; });
  await cancelPair.s
    .getByRole("button", { name: "⏸ Pause", exact: true })
    .click();
  await cancelReceiver.r.locator(".remote-pause-banner").waitFor({ timeout: 3000 });
  await cancelReceiver.r.waitForTimeout(200);
  const senderPausedBytes = await cancelReceiver.r.evaluate(() => window.__rxBytes);
  await cancelReceiver.r.waitForTimeout(400);
  assert.equal(await cancelReceiver.r.evaluate(() => window.__rxBytes), senderPausedBytes);
  await cancelReceiver.r.evaluate(() => { window.__failControls = ['pause', 'resume']; });
  await cancelReceiver.r.getByRole('button', { name: '⏸ Pause', exact: true }).click();
  await cancelPair.s.locator('.remote-pause-banner').waitFor({ timeout: 3000 });
  await cancelPair.s
    .getByRole("button", { name: "▶ Resume", exact: true })
    .click();
  await cancelReceiver.r.locator(".remote-pause-banner").waitFor({ state: 'hidden', timeout: 3000 });
  await cancelReceiver.r.waitForTimeout(300);
  assert.equal(await cancelReceiver.r.evaluate(() => window.__rxBytes), senderPausedBytes, 'receiver pause must survive a sender resume');
  await cancelReceiver.r.getByRole('button', { name: '▶ Resume', exact: true }).click();
  await cancelReceiver.r.waitForFunction(previous => window.__rxBytes > previous + 65536, senderPausedBytes, { timeout: 3000 });
  cancelReceiver.r.once("dialog", (dialog) => dialog.accept());
  await cancelReceiver.r
    .getByRole("button", { name: "✕ Cancel", exact: true })
    .click();
  await cancelReceiver.r.locator(".code-input").waitFor();
  await cancelPair.s.locator(".file-cancel-badge").waitFor();
  console.log("PASS: sender pause/resume and receiver cancel propagation");
  assert.deepEqual(errors, []);
} catch (error) {
  for (const context of browser.contexts())
    for (const p of context.pages())
      console.log(
        JSON.stringify({
          url: p.url(),
          body: await p.locator("body").innerText(),
          debug: await p.evaluate(() => ({
            pcs: window.__pcs?.map((pc) => ({
              connection: pc.connectionState,
              ice: pc.iceConnectionState,
              signalling: pc.signalingState,
              gathering: pc.iceGatheringState,
              local: pc.localDescription?.type,
              remote: pc.remoteDescription?.type,
            })),
            controls: window.__controls?.slice(-12),
            rx: window.__rxBytes,
            sent: window.__sentBytes,
          })),
          errors,
        }),
      );
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await rm(fixtureDir, { recursive: true, force: true });
}
