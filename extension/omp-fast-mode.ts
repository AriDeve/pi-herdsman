import type {
  Model,
  ServiceTierByFamily,
  ServiceTierFamily,
  ServiceTier,
} from "@oh-my-pi/pi-ai/types";
import {
  serviceTierFamily,
  realizesPriorityServiceTier,
} from "@oh-my-pi/pi-ai";

type NativeTierAPI = {
  getServiceTiers(): Readonly<ServiceTierByFamily>;
  setServiceTier(
    family: ServiceTierFamily,
    tier: ServiceTier | undefined,
  ): void;
};

/** Apply only at launch, after native session/model restoration. */
export function applyOmpFastMode(
  pi: NativeTierAPI,
  model: Model | undefined,
  fastMode: boolean | undefined,
): string | undefined {
  if (fastMode === undefined) return;
  const family = model ? serviceTierFamily(model) : undefined;
  if (
    fastMode &&
    model &&
    family &&
    realizesPriorityServiceTier("priority", model)
  ) {
    pi.setServiceTier(family, "priority");
    return;
  }
  if (family) {
    const tier = pi.getServiceTiers()[family];
    if (tier === "priority" || tier === "ultrafast")
      pi.setServiceTier(family, undefined);
  }
  if (fastMode)
    return `Fast mode is unavailable for ${model ? `${model.provider}/${model.id}` : "the selected model"}; the Agent continues without fast mode.`;
}
