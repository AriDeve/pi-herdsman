import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sendDesktopNotification } from "./desktop-notifications.ts";

test(
  "Linux desktop delivery rejects missing and failed tools without evaluating notification text",
  { skip: process.platform !== "linux" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdsman-notification-test-"));
    const originalPath = process.env.PATH;
    const originalCapture = process.env.NOTIFICATION_TEST_CAPTURE;
    try {
      process.env.PATH = dir;
      await assert.rejects(
        sendDesktopNotification({ title: "title", body: "body" }),
        /notify-send/i,
      );
      process.env.PATH = `${dir}:/usr/bin:/bin`;

      const executable = join(dir, "notify-send");
      const capture = join(dir, "arguments");
      const injectedFile = join(dir, "injected");
      process.env.NOTIFICATION_TEST_CAPTURE = capture;
      writeFileSync(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOTIFICATION_TEST_CAPTURE"\n',
      );
      chmodSync(executable, 0o755);
      const title = `$(touch ${injectedFile})`;
      await sendDesktopNotification({ title, body: "' ; exit 99 ; #" });
      assert.ok(readFileSync(capture, "utf8").includes(title));
      assert.throws(() => readFileSync(injectedFile));

      writeFileSync(
        executable,
        '#!/bin/sh\nprintf "notification daemon unavailable\\n" >&2\nexit 17\n',
      );
      await assert.rejects(
        sendDesktopNotification({ title: "title", body: "body" }),
        /notification daemon unavailable/i,
      );

      writeFileSync(
        executable,
        '#!/bin/sh\ni=0; while [ \"$i\" -lt 3000 ]; do printf x >&2; i=$((i+1)); done\nexit 1\n',
      );
      await assert.rejects(
        sendDesktopNotification({ title: "title", body: "body" }),
        (error: Error) => {
          assert.ok(error.message.length < 2500);
          return true;
        },
      );

      writeFileSync(executable, "#!/bin/sh\nexec /bin/sleep 30\n");
      await assert.rejects(
        sendDesktopNotification({ title: "title", body: "body" }),
        /timed out/i,
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCapture === undefined)
        delete process.env.NOTIFICATION_TEST_CAPTURE;
      else process.env.NOTIFICATION_TEST_CAPTURE = originalCapture;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
