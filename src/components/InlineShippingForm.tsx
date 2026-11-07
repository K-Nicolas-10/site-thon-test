import { useState } from "react";

const METHODS = ["Standard (3-5 days)", "Express (1-2 days)"];

/**
 * The shipping details on one screen: country, postcode and delivery method are all visible at
 * once, so narrow viewports don't have to page through a multi-step wizard to save them.
 */
export function InlineShippingForm({ onDone }: { onDone: () => void }) {
  const [done, setDone] = useState(false);

  return (
    <form
      className="shipping inline"
      data-component="InlineShippingForm"
      data-slot="shipping"
      data-target-os="any"
      data-price-tier="n/a"
      data-layout-density="low"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(true);
        onDone();
      }}
    >
      <p className="hint">{done ? "Shipping details saved." : "Where should we send it?"}</p>
      {!done && (
        <>
          <div className="shipping-fields">
            <label className="field">
              Country
              <input name="shipping_country" required />
            </label>
            <label className="field">
              Postcode
              <input name="shipping_zip" required />
            </label>
            <label className="field">
              Delivery method
              <select name="shipping_method">
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="next" type="submit">
            Save shipping
          </button>
        </>
      )}
    </form>
  );
}
