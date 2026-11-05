// Drive the installed Chromium browser, not a replacement dashboard.
// Also usable directly: bun scripts/omp-dashboard-capture.mjs URL OUTPUT_DIRECTORY
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function captureDashboard(url, directory, expectedTracks) {
  await mkdir(directory, { recursive: true });
  const profile = join(directory, "chrome-profile");
  const browser = Bun.spawn(
    [
      "google-chrome-stable",
      "--headless",
      "--no-first-run",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      stdout: "ignore",
      stderr: Bun.file(join(directory, "chrome.stderr.log")),
    },
  );
  let websocket;
  let sequence = 0;
  const pending = new Map();
  const events = [];
  const command = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timeout });
      websocket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  try {
    const deadline = Date.now() + 15000;
    let port;
    for (;;) {
      assert.equal(
        browser.exitCode,
        null,
        `browser exited: ${await readFile(join(directory, "chrome.stderr.log"), "utf8")}`,
      );
      try {
        port = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.ok(Date.now() < deadline, "Chrome debugging endpoint not ready");
      await Bun.sleep(100);
    }
    const version = await (
      await fetch(`http://127.0.0.1:${port}/json/version`)
    ).json();
    websocket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      websocket.onopen = resolve;
      websocket.onerror = reject;
    });
    websocket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.id) {
        events.push(payload);
        return;
      }
      const request = pending.get(payload.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(payload.id);
      if (payload.error)
        request.reject(new Error(JSON.stringify(payload.error)));
      else request.resolve(payload.result);
    };
    const { targetId } = await command("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await command("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await command("Page.enable", {}, sessionId);
    await command("Runtime.enable", {}, sessionId);
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await command("Page.navigate", { url }, sessionId);
    let dom;
    const readyDeadline = Date.now() + 20000;
    for (;;) {
      const evaluation = await command(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify({title:document.title,text:document.body?.innerText ?? '',buttons:[...document.querySelectorAll('button')].map(b=>b.textContent),errors:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)})`,
          returnByValue: true,
        },
        sessionId,
      );
      dom = JSON.parse(evaluation.result.value);
      if (dom.buttons.includes("Expand all")) break;
      assert.ok(
        Date.now() < readyDeadline,
        `native trace UI not ready: ${dom.text}`,
      );
      await Bun.sleep(150);
    }
    await command(
      "Runtime.evaluate",
      {
        expression: `[...document.querySelectorAll('button')].find(b=>b.textContent==='Expand all').click()`,
      },
      sessionId,
    );
    await Bun.sleep(250);
    const snapshot = await command(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify({title:document.title,url:location.href,text:document.body.innerText,trackLabels:[...document.querySelectorAll('.traces-gutter-track')].map(e=>e.textContent)})`,
        returnByValue: true,
      },
      sessionId,
    );
    dom = JSON.parse(snapshot.result.value);
    await writeFile(
      join(directory, "native-dashboard-dom.json"),
      JSON.stringify(dom, null, 2),
    );
    await writeFile(
      join(directory, "browser-events.json"),
      JSON.stringify(events, null, 2),
    );
    const screenshot = await command(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true },
      sessionId,
    );
    await writeFile(
      join(directory, "native-dashboard.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    assert.ok(dom.text.includes("Main"), "native trace root must render");
    if (expectedTracks)
      assert.equal(
        dom.trackLabels.length,
        expectedTracks,
        "every expanded native track must render",
      );
    await command("Target.closeTarget", { targetId });
    return {
      title: dom.title,
      url: dom.url,
      screenshot: join(directory, "native-dashboard.png"),
    };
  } finally {
    websocket?.close();
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("browser closing"));
    }
    if (browser.exitCode === null) browser.kill();
    const exited = await Promise.race([
      browser.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    assert.ok(exited, `owned Chrome did not exit: pid=${browser.pid}`);
    await writeFile(
      join(directory, "browser-cleanup.json"),
      JSON.stringify({ pid: browser.pid, exitCode: browser.exitCode }),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(
    process.argv[2] && process.argv[3],
    "usage: bun scripts/omp-dashboard-capture.mjs URL OUTPUT_DIRECTORY",
  );
  console.log(await captureDashboard(process.argv[2], process.argv[3]));
}
