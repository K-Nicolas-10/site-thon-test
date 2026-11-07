import { useEffect, useLayoutEffect, useState } from "react";
import type { ComponentType } from "react";
import {
  CartProvider,
  api,
  cartSid,
  cohort,
  inCatalog,
  markConverted,
  money,
  placeOrder,
  priceTier,
  step,
  useCart,
  variant,
} from "@stride/shared";
import type { Product } from "@stride/shared";
import { registry } from "./registry";

/**
 * The shop's views. The hero, the finder and the shipping selector are slots the variant config
 * fills from the registry (ADR 0001, D-24). The cart is a separate page, reached from a small link
 * in the footer, and the product CTA sits above the price.
 */
export function App() {
  return (
    <CartProvider>
      <Router />
    </CartProvider>
  );
}

export type Route =
  | { name: "home" }
  | { name: "product"; id: string }
  | { name: "cart" }
  | { name: "confirmation"; orderId: string };

function Slot({ slot, ...props }: { slot: string } & Record<string, unknown>) {
  const name = cohort.slots[slot];
  const Component = (registry as Record<string, ComponentType<any>>)[name];
  // A config naming a component the registry lacks must fail QA loudly (D-28).
  if (!Component) throw new Error(`Unknown component "${name}" in slot "${slot}"`);
  return <Component {...props} />;
}

function useCheckout(go: (r: Route) => void) {
  const { clearLocal } = useCart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout(email = "", before?: () => Promise<void>) {
    setBusy(true);
    setError(null);
    step("payment");
    try {
      await before?.();
      const order = await placeOrder(cartSid(), email);
      markConverted(order.total_cents / 100);
      clearLocal();
      go({ name: "confirmation", orderId: order.id });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, checkout };
}

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
  // A layout effect runs before the views' own effects, so a view can report a deeper step.
  useLayoutEffect(() => step(route.name === "home" ? "landing" : route.name), [route.name]);
  return (
    <div className="shell">
      <Nav route={route} go={setRoute} />
      {route.name === "home" && <Home go={setRoute} />}
      {route.name === "product" && <ProductPage id={route.id} go={setRoute} />}
      {route.name === "cart" && <CartPage go={setRoute} />}
      {route.name === "confirmation" && <Confirmation orderId={route.orderId} go={setRoute} />}
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

function Home({ go }: { go: (r: Route) => void }) {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    api.products().then((r) => setProducts(r.products.filter(inCatalog)));
  }, []);

  return (
    <main>
      <Slot slot="hero" />
      <Slot slot="finder" products={products} go={go} />
      <ExpressCheckout products={products} go={go} />

      <section
        className="why"
        id="why"
        data-component="WhyStride"
        data-target-os="any"
        data-price-tier="n/a"
        data-layout-density="medium"
      >
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

      <p className="variant">Variant {variant.variant_id ?? "baseline"}</p>
    </main>
  );
}

/** One-click purchase of the bag, or of today's pick when the bag is empty. */
function ExpressCheckout({ products, go }: { products: Product[]; go: (r: Route) => void }) {
  const { cart, add } = useCart();
  const { busy, error, checkout } = useCheckout(go);
  const pick = products.find((p) => p.in_stock);

  return (
    <section
      className="express"
      data-component="ExpressCheckout"
      data-target-os="any"
      data-price-tier="mixed"
      data-layout-density="low"
    >
      <div>
        <h2>{cart.count ? "Ready when you are" : "Today's pick"}</h2>
        <p className="hint">
          {cart.count
            ? `${cart.count} in your bag, ${money(cart.subtotal_cents)}`
            : pick && `${pick.name}, ${money(pick.price_cents)}`}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <button
        className="next"
        disabled={busy || (!cart.count && !pick)}
        onClick={() => checkout("", cart.count || !pick ? undefined : () => add(pick.id))}
      >
        {busy ? "Placing order…" : "Checkout"}
      </button>
    </section>
  );
}

function Confirmation({ orderId, go }: { orderId: string; go: (r: Route) => void }) {
  return (
    <main
      className="cart"
      data-component="Confirmation"
      data-testid="confirmation"
      data-order-id={orderId}
    >
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

function ProductPage({ id, go }: { id: string; go: (r: Route) => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const { add } = useCart();

  useEffect(() => {
    api.product(id).then((r) => {
      setProduct(r.product);
      setSize(r.product.sizes[0]);
      setColor(r.product.colors[0].name);
    });
  }, [id]);

  if (!product) return <main className="loading">Loading product…</main>;

  return (
    <main
      className="product"
      data-component="ProductDetail"
      data-target-os="any"
      data-price-tier={priceTier(product.price_cents)}
      data-layout-density="high"
    >
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
                <select name="product_size" value={size} onChange={(e) => setSize(e.target.value)}>
                  {product.sizes.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Colour
                <select name="product_color" value={color} onChange={(e) => setColor(e.target.value)}>
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
              onClick={() => add(product.id)}
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
  const { cart, update, remove } = useCart();
  const { busy, error, checkout } = useCheckout(go);
  const [email, setEmail] = useState("");
  const [shipped, setShipped] = useState(false);
  const hasLines = cart.lines.length > 0;

  useEffect(() => {
    if (hasLines) step("shipping");
  }, [hasLines]);

  return (
    <main
      className="cart"
      data-component="CartDrawer"
      data-slot="cart"
      data-target-os="any"
      data-price-tier="mixed"
      data-layout-density="medium"
    >
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
                  name="cart_qty"
                  aria-label={`Quantity of ${l.name}`}
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
          <Slot slot="shipping" onDone={() => setShipped(true)} />
          <label className="field">
            Email for receipt
            <input name="payment_email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="next" disabled={busy || !shipped} onClick={() => checkout(email)}>
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
