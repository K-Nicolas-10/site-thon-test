import { useState } from "react";
import { money, useCart } from "@stride/shared";
import type { Product } from "@stride/shared";
import type { Route } from "./App";

const STEPS = ["What are you shopping for?", "What size do you wear?", "Here is what we suggest"];

/**
 * A three-step wizard (category → size → product) that gates the shop behind choices nobody asked
 * for: the kind of friction the loop exists to measure.
 */
export function GuidedFinder({ products, go }: { products: Product[]; go: (r: Route) => void }) {
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);

  const filtered = products.filter(
    (p) =>
      (!category || p.category === category) &&
      (!size || p.sizes.includes(size) || p.sizes.includes("One size")),
  );

  return (
    <div
      data-component="GuidedFinder"
      data-slot="finder"
      data-target-os="any"
      data-price-tier="mixed"
      data-layout-density="high"
    >
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "step current" : i < step ? "step done" : "step"}>
            <span className="num">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <section className="panel">
        {step === 0 && (
          <div className="choice-grid">
            {[
              { key: "footwear", label: "Footwear", note: "Shoes, boots, sneakers" },
              { key: "headwear", label: "Headwear", note: "Caps, beanies, hats" },
              { key: "accessories", label: "Accessories", note: "Socks, bags, bottles" },
            ].map((c) => (
              <button
                key={c.key}
                className={category === c.key ? "choice on" : "choice"}
                onClick={() => {
                  setCategory(c.key);
                  setStep(1);
                }}
              >
                <b>{c.label}</b>
                <small>{c.note}</small>
              </button>
            ))}
            <button className="skip" onClick={() => setStep(2)}>
              Skip — show me everything
            </button>
          </div>
        )}

        {step === 1 && (
          <div>
            <p className="hint">
              Pick the size you normally wear. We will show everything available in that size, plus
              one-size items.
            </p>
            <div className="sizes">
              {["36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46"].map((s) => (
                <button
                  key={s}
                  className={size === s ? "size on" : "size"}
                  onClick={() => setSize(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="row">
              <button className="back" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="next" onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="result-head">
              <h2>
                {filtered.length} {filtered.length === 1 ? "item" : "items"} match
              </h2>
              <button className="back" onClick={() => setStep(0)}>
                Start over
              </button>
            </div>
            <ul className="results">
              {filtered.map((p) => (
                <ResultRow key={p.id} product={p} go={go} />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function ResultRow({ product, go }: { product: Product; go: (r: Route) => void }) {
  const { add } = useCart();
  return (
    <li className="result">
      <div
        className="swatch"
        style={{ background: `linear-gradient(140deg, ${product.swatch[0]}, ${product.swatch[1]})` }}
      />
      <div className="result-main">
        <h3>{product.name}</h3>
        <p className="result-short">{product.short}</p>
        <p className="result-meta">
          {product.category} · ★ {product.rating.toFixed(1)} ({product.reviews}) ·{" "}
          {product.in_stock ? "In stock" : "Out of stock"}
        </p>
      </div>
      <div className="result-side">
        <span className="price">{money(product.price_cents)}</span>
        <button className="quick" disabled={!product.in_stock} onClick={() => add(product.id)}>
          Quick add
        </button>
        <button className="textlink" onClick={() => go({ name: "product", id: product.id })}>
          Details
        </button>
      </div>
    </li>
  );
}
