import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { fileURLToPath } from "node:url";

// Exercise persisted native OMP files through the same import adapter as extensions.
const checks = await loadLegacyPiModule(
  fileURLToPath(
    new URL("../extension/foreign-session.check.ts", import.meta.url),
  ),
);
if (
  !checks ||
  typeof checks !== "object" ||
  !("checkForeignSessionInspection" in checks) ||
  typeof checks.checkForeignSessionInspection !== "function"
)
  throw new Error("Native OMP session check is unavailable");
checks.checkForeignSessionInspection();
console.log("Native OMP session inspection passed");
