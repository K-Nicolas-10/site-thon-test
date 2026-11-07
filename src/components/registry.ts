// Every component a variant config may reference by name (variant-config.schema.json → componentName).
// Each slot renders with fixed props: hero gets none, finder gets { products, go }, shipping gets { onDone }.
// Tag the root element with data-component and data-* tags: the beacon reports them as the manifest (D-20).
import { GuidedFinder } from "./GuidedFinder";
import { Hero_Android_Ecosystem } from "./Hero_Android_Ecosystem";
import { Hero_Apple_Ecosystem } from "./Hero_Apple_Ecosystem";
import { MultiStepShippingSelector } from "./MultiStepShippingSelector";

export const registry = {
  Hero_Apple_Ecosystem,
  Hero_Android_Ecosystem,
  GuidedFinder,
  MultiStepShippingSelector,
} as const;

export type ComponentName = keyof typeof registry;
