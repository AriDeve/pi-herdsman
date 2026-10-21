import { all, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface OmpLaunchSettings {
  disabledExtensions: string[];
  skills: Record<string, unknown>;
}

/** Read the live session scope, including CLI overlays, without changing settings. */
export async function readOmpLaunchSettings(
  cwd: string,
): Promise<OmpLaunchSettings> {
  const scope = await SettingsManager.create(cwd, getAgentDir());
  const disabled = lookup("disabledExtensions")?.get(scope);
  if (
    disabled !== undefined &&
    (!Array.isArray(disabled) ||
      !disabled.every((id) => typeof id === "string"))
  )
    throw new Error("Invalid OMP disabledExtensions setting");
  const skills: Record<string, unknown> = {};
  for (const setting of all())
    if (setting.id.startsWith("skills."))
      skills[setting.id.slice("skills.".length)] = setting.get(scope);
  return { disabledExtensions: disabled ?? [], skills };
}
