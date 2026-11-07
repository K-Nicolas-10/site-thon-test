export type Category = "footwear" | "headwear" | "accessories";

export interface Color {
  name: string;
  hex: string;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  category: Category;
  price_cents: number;
  compare_at_cents: number | null;
  short: string;
  description: string;
  materials: string[];
  sizes: string[];
  colors: Color[];
  rating: number;
  reviews: number;
  badge: string | null;
  in_stock: boolean;
  swatch: [string, string];
}

export interface CartLine {
  product_id: string;
  name: string;
  slug: string;
  price_cents: number;
  qty: number;
  line_total_cents: number;
  swatch: [string, string];
}

export interface Cart {
  lines: CartLine[];
  count: number;
  subtotal_cents: number;
  shipping_cents: number;
}

export interface Order {
  id: string;
  items: { product_id: string; name: string; qty: number; unit_price_cents: number }[];
  total_cents: number;
  status: "pending" | "paid";
  email: string;
  created_at: string;
}

const base = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  products: (params: { category?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    const s = qs.toString();
    return req<{ products: Product[] }>(`/products${s ? `?${s}` : ""}`);
  },
  product: (id: string) => req<{ product: Product }>(`/products/${encodeURIComponent(id)}`),
  cart: (sid: string) => req<Cart>(`/cart?sid=${encodeURIComponent(sid)}`),
  addToCart: (sid: string, productId: string, qty = 1) =>
    req<Cart>(`/cart`, { method: "POST", body: JSON.stringify({ sid, product_id: productId, qty }) }),
  updateCart: (sid: string, productId: string, qty: number) =>
    req<Cart>(`/cart/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: JSON.stringify({ sid, qty }),
    }),
  removeFromCart: (sid: string, productId: string) =>
    req<Cart>(`/cart/${encodeURIComponent(productId)}?sid=${encodeURIComponent(sid)}`, {
      method: "DELETE",
    }),
  checkout: (sid: string, email: string) =>
    req<{ order: Order }>(`/checkout`, { method: "POST", body: JSON.stringify({ sid, email }) }),
  order: (id: string) => req<{ order: Order }>(`/orders/${encodeURIComponent(id)}`),
};

/** Check out, then wait for the payment webhook: the order only counts once it is paid. */
export async function placeOrder(sid: string, email: string): Promise<Order> {
  const { order } = await api.checkout(sid, email);
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await api.order(order.id);
    if (current.order.status === "paid") return current.order;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Payment was not confirmed in time.");
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function cartSid(): string {
  let sid = localStorage.getItem("stride.sid");
  if (!sid) {
    // Not crypto.randomUUID: it only exists on HTTPS, and QA reaches the shop over plain HTTP.
    sid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    localStorage.setItem("stride.sid", sid);
  }
  return sid;
}
