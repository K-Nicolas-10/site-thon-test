import { useState } from "react";

const METHODS = ["Standard (3-5 days)", "Express (1-2 days)"];
const STEPS = [
  { name: "shipping_country", label: "Country" },
  { name: "shipping_zip", label: "Postcode" },
  { name: "shipping_method", label: "Delivery method" },
];

export function MultiStepShippingSelector({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const { name, label } = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <form
      className="shipping"
      data-component="MultiStepShippingSelector"
      data-slot="shipping"
      data-target-os="any"
      data-price-tier="n/a"
      data-layout-density="high"
      onSubmit={(e) => {
        e.preventDefault();
        if (last) {
          setDone(true);
          onDone();
        } else {
          setStep(step + 1);
        }
      }}
    >
      <p className="hint">
        {done ? "Shipping details saved." : `Shipping: step ${step + 1} of ${STEPS.length}`}
      </p>
      {!done && (
        <>
          <label className="field">
            {label}
            {last ? (
              <select name={name}>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input key={name} name={name} required />
            )}
          </label>
          <button className="next" type="submit">
            {last ? "Save shipping" : "Next"}
          </button>
        </>
      )}
    </form>
  );
}
