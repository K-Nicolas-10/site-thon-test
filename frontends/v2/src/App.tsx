import { useEffect, useState } from "react";
import {
  AbProvider,
  CartProvider,
  api,
  money,
  useAb,
  useCart,
  useTrackClick,
} from "@stride/shared";
import type { Product } from "@stride/shared";

/**
 * V2 — "The guided journey."
 * A three-step landing wizard (category → size → product) that gates the
 * shop behind choices nobody asked for. The cart is a separate page, reached
 * from a small link in the footer, and the product CTA sits above the price.
 */
export function App() {
  return (
    <AbProvider fallback={<p className="boot">Loading…</p>}>
      <CartProvider>
        <Router />
      </CartProvider>
    </AbProvider>
  );
}

type Route = { name: "home" } | { name: "product"; id: string } | { name: "cart" };

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>({ name: "home" });
  useEffect(() => {
    const onPop = () => setRoute({ name: "home" });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return [route, setRoute];
}

function Router() {
  const [route, setRoute] = useRoute();
  return (
    <div className="shell">
      <Nav route={route} go={setRoute} />
      {route.name === "home" && <Home go={setRoute} />}
      {route.name === "product" && <ProductPage id={route.id} go={setRoute} />}
      {route.name === "cart" && <CartPage go={setRoute} />}
      <Foot go={setRoute} />
    </div>
  );
}

function Nav({ route, go }: { route: Route; go: (r: Route) => void }) {
  return (
    <header className="nav">
      <button className="logo" onClick={() => go({ name: "home" })}>
        Stride<span>.</span>
      </button>
      <nav className="nav-links">
        <button onClick={() => go({ name: "home" })} className={route.name === "home" ? "on" : ""}>
          Shop
        </button>
        <a href="#why">Why Stride</a>
        <a href="#help">Help</a>
      </nav>
    </header>
  );
}

const STEPS = ["What are you shopping for?", "What size do you wear?", "Here is what we suggest"];

function Home({ go }: { go: (r: Route) => void }) {
  const { assignment } = useAb();
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    api.products().then((r) => setProducts(r.products));
  }, []);

  const filtered = products.filter(
    (p) =>
      (!category || p.category === category) &&
      (!size || p.sizes.includes(size) || p.sizes.includes("One size")),
  );

  return (
    <main>
      <section className="intro">
        <p className="kicker">A considered shop for footwear, headwear and accessories</p>
        <h1>
          Find the thing
          <br />
          you will actually wear.
        </h1>
        <p className="intro-copy">
          We stock a small, carefully chosen range. Answer three short questions and we will
          narrow it down for you.
        </p>
      </section>

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
              Pick the size you normally wear. We will show everything available in that size,
              plus one-size items.
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

      <section className="why" id="why">
        <h2>Why Stride</h2>
        <div className="why-grid">
          <div>
            <h3>Small range</h3>
            <p>
              We would rather stock twelve things we believe in than two hundred we do not. Every
              product on this page has been worn by someone on the team for at least a month
              before it went live.
            </p>
          </div>
          <div>
            <h3>Honest descriptions</h3>
            <p>
              If a boot takes two weeks to break in, we say so. If a hat is not waterproof, we say
              so. The description is written by the person who tested it, not by a copywriter.
            </p>
          </div>
          <div>
            <h3>Simple returns</h3>
            <p>
              Thirty days, no questions, and we pay the return postage. If something does not fit,
              that is our problem to solve, not yours.
            </p>
          </div>
        </div>
      </section>

      <p className="variant">Variant {assignment?.variant ?? "…"}</p>
    </main>
  );
}

function ResultRow({ product, go }: { product: Product; go: (r: Route) => void }) {
  const { add } = useCart();
  const trackClick = useTrackClick();
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
        <button
          className="quick"
          disabled={!product.in_stock}
          onClick={() => add(product.id, 1, { from: "quick_add" })}
        >
          Quick add
        </button>
        <button
          className="textlink"
          onClick={() => {
            trackClick("open_product", { product_id: product.id });
            go({ name: "product", id: product.id });
          }}
        >
          Details
        </button>
      </div>
    </li>
  );
}

function ProductPage({ id, go }: { id: string; go: (r: Route) => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const { add } = useCart();
  const trackClick = useTrackClick();

  useEffect(() => {
    api.product(id).then((r) => {
      setProduct(r.product);
      setSize(r.product.sizes[0]);
      setColor(r.product.colors[0].name);
    });
  }, [id]);

  if (!product) return <main className="loading">Loading product…</main>;

  return (
    <main className="product">
      <button className="back" onClick={() => go({ name: "home" })}>
        ← Back to results
      </button>
      <div className="product-grid">
        <div
          className="product-img"
          style={{ background: `linear-gradient(140deg, ${product.swatch[0]}, ${product.swatch[1]})` }}
        />
        <div className="product-info">
          <p className="kicker">{product.category}</p>
          <h1>{product.name}</h1>
          <p className="product-short">{product.short}</p>
          <p className="long">{product.description}</p>

          <div className="specs">
            <div>
              <h4>Materials</h4>
              <ul>
                {product.materials.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>Care</h4>
              <p>Wipe clean with a damp cloth. Air dry away from direct heat. Do not tumble dry.</p>
            </div>
            <div>
              <h4>Delivery &amp; returns</h4>
              <p>Free delivery over $75. Thirty-day returns, return postage paid by us.</p>
            </div>
          </div>

          <div className="buy">
            <div className="pickers">
              <label>
                Size
                <select value={size} onChange={(e) => setSize(e.target.value)}>
                  {product.sizes.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Colour
                <select value={color} onChange={(e) => setColor(e.target.value)}>
                  {product.colors.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="price-row">
              <span className="big-price">{money(product.price_cents)}</span>
              {product.compare_at_cents && (
                <s>{money(product.compare_at_cents)}</s>
              )}
            </div>
            <button
              className="add"
              disabled={!product.in_stock}
              onClick={() => {
                add(product.id, 1, { size, color });
                trackClick("add_to_cart_button", { product_id: product.id });
              }}
            >
              {product.in_stock ? "Add to cart" : "Out of stock"}
            </button>
            <p className="ship-note">Free shipping over $75 · 30-day returns</p>
          </div>
        </div>
      </div>
    </main>
  );
}

function CartPage({ go }: { go: (r: Route) => void }) {
  const { cart, update, remove, clearLocal } = useCart();
  const { track } = useAb();
  const [email, setEmail] = useState("");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (orderId) {
    return (
      <main className="cart">
        <h1>Order placed</h1>
        <p>
          Thank you. Your order reference is <b>{orderId}</b>.
        </p>
        <button className="next" onClick={() => go({ name: "home" })}>
          Back to the shop
        </button>
      </main>
    );
  }

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const { order } = await api.checkout(localStorage.getItem("stride.sid") ?? "", email);
      track("purchase", {
        order_id: order.id,
        value_cents: order.total_cents,
        items: order.items.length,
      });
      clearLocal();
      setOrderId(order.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="cart">
      <h1>Your bag</h1>
      {cart.lines.length === 0 ? (
        <p className="hint">Nothing in here yet.</p>
      ) : (
        <>
          <ul className="cart-lines">
            {cart.lines.map((l) => (
              <li key={l.product_id}>
                <span
                  className="swatch small"
                  style={{ background: `linear-gradient(140deg, ${l.swatch[0]}, ${l.swatch[1]})` }}
                />
                <span className="name">{l.name}</span>
                <input
                  type="number"
                  min={1}
                  value={l.qty}
                  onChange={(e) => update(l.product_id, Number(e.target.value))}
                />
                <span>{money(l.line_total_cents)}</span>
                <button className="textlink" onClick={() => remove(l.product_id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="summary">
            <p>
              Subtotal <b>{money(cart.subtotal_cents)}</b>
            </p>
            <p>
              Shipping <b>{cart.shipping_cents ? money(cart.shipping_cents) : "Free"}</b>
            </p>
          </div>
          <label className="field">
            Email for receipt
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="next" disabled={busy} onClick={checkout}>
            {busy ? "Placing order…" : "Place order"}
          </button>
        </>
      )}
      <button className="back" onClick={() => go({ name: "home" })}>
        ← Keep shopping
      </button>
    </main>
  );
}

function Foot({ go }: { go: (r: Route) => void }) {
  const { cart } = useCart();
  return (
    <footer className="foot" id="help">
      <div className="foot-cols">
        <div>
          <h4>Shop</h4>
          <a href="#">Footwear</a>
          <a href="#">Headwear</a>
          <a href="#">Accessories</a>
        </div>
        <div>
          <h4>Help</h4>
          <a href="#">Delivery</a>
          <a href="#">Returns</a>
          <a href="#">Size guide</a>
        </div>
        <div>
          <h4>Company</h4>
          <a href="#">About</a>
          <a href="#">Careers</a>
          <a href="#">Contact</a>
        </div>
      </div>
      <div className="foot-bottom">
        <span>© Stride, a demonstration store.</span>
        <button className="bag-link" onClick={() => go({ name: "cart" })}>
          Bag ({cart.count})
        </button>
      </div>
    </footer>
  );
}
