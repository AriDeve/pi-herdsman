import { spawn } from "node:child_process";

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_BYTES = 2_048;

// Windows' built-in PowerShell Start-menu shortcut supplies this implicit AppUserModelID.
// Verify that the shortcut is registered: Windows can otherwise silently discard a toast.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Get-StartApps | Where-Object { $_.AppID -eq $appId })) {
  throw 'Windows PowerShell Start-menu shortcut is not registered; restore it and check Get-StartApps.'
}
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:HERDSMAN_NOTIFICATION_DATA)) | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$text = $xml.GetElementsByTagName('text')
[void]$text.Item(0).AppendChild($xml.CreateTextNode([string]$data.title))
[void]$text.Item(1).AppendChild($xml.CreateTextNode([string]$data.body))
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
if ($notifier.Setting.ToString() -ne 'Enabled') { throw "Windows notifications are disabled: $($notifier.Setting). Check Windows notification settings." }
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

const MAC_SCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"
end run`;

type DesktopNotification = { title: string; body: string };

/** Submit an independent OS notification, or reject with an actionable delivery error. */
export async function sendDesktopNotification(
  notification: DesktopNotification,
): Promise<void> {
  let command: string;
  let args: string[];
  let env = process.env;
  let prerequisite: string;
  switch (process.platform) {
    case "linux":
      command = "notify-send";
      // notify-send decompresses C escapes; notification daemons may parse body markup.
      args = [
        "--app-name=Pi Herdsman",
        "--hint=string:sound-name:message-new-instant",
        "--",
        notification.title,
        notification.body
          .replace(/\\/g, "\\\\")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      ];
      prerequisite =
        "Install notify-send and enable a desktop D-Bus notification service";
      break;
    case "darwin":
      command = "osascript";
      args = ["-e", MAC_SCRIPT, "--", notification.title, notification.body];
      prerequisite =
        "Allow notifications for the script host in macOS settings";
      break;
    case "win32":
      command = "powershell.exe";
      args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64"),
      ];
      env = {
        ...process.env,
        HERDSMAN_NOTIFICATION_DATA: Buffer.from(
          JSON.stringify(notification),
          "utf8",
        ).toString("base64"),
      };
      prerequisite =
        "Restore the Windows PowerShell Start-menu shortcut and allow its notifications";
      break;
    default:
      throw new Error(
        `Desktop notifications are unsupported on ${process.platform}.`,
      );
  }

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let child;
  try {
    child = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      `Could not run ${command}: ${String(error)}. ${prerequisite}.`,
    );
  }
  let diagnostic = Buffer.alloc(0);
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stderr?.destroy();
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(
      new Error(
        `${command} timed out after ${DELIVERY_TIMEOUT_MS} ms. ${prerequisite}.`,
      ),
    );
  }, DELIVERY_TIMEOUT_MS);
  child.stderr?.on("data", (chunk: Buffer) => {
    const remaining = MAX_DIAGNOSTIC_BYTES - diagnostic.length;
    if (remaining > 0)
      diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, remaining)]);
  });
  child.on("error", (error) =>
    finish(
      new Error(`Could not run ${command}: ${error.message}. ${prerequisite}.`),
    ),
  );
  child.on("close", (code, signal) => {
    if (code === 0) return finish();
    const detail = diagnostic
      .toString("utf8")
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .trim();
    finish(
      new Error(
        `${command} failed (${signal ?? `exit ${code}`}): ${detail || "no diagnostic"}. ${prerequisite}.`,
      ),
    );
  });
  await promise;
}
