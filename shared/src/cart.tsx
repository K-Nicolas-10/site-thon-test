import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, cartSid } from "./api";
import type { Cart } from "./api";
import { useAb } from "./ab";

interface CartContextValue {
  cart: Cart;
  loading: boolean;
  add: (productId: string, qty?: number, props?: Record<string, unknown>) => Promise<void>;
  update: (productId: string, qty: number) => Promise<void>;
  remove: (productId: string) => Promise<void>;
  clearLocal: () => void;
}

const empty: Cart = { lines: [], count: 0, subtotal_cents: 0, shipping_cents: 0 };
const CartContext = createContext<CartContextValue>({
  cart: empty,
  loading: false,
  add: async () => {},
  update: async () => {},
  remove: async () => {},
  clearLocal: () => {},
});

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Cart>(empty);
  const [loading, setLoading] = useState(true);
  const { track } = useAb();
  const sid = useMemo(cartSid, []);

  useEffect(() => {
    api
      .cart(sid)
      .then(setCart)
      .catch(() => setCart(empty))
      .finally(() => setLoading(false));
  }, [sid]);

  const add = useCallback(
    async (productId: string, qty = 1, props: Record<string, unknown> = {}) => {
      const next = await api.addToCart(sid, productId, qty);
      setCart(next);
      track("add_to_cart", { product_id: productId, qty, ...props });
    },
    [sid, track],
  );

  const update = useCallback(
    async (productId: string, qty: number) => {
      setCart(await api.updateCart(sid, productId, qty));
    },
    [sid],
  );

  const remove = useCallback(
    async (productId: string) => {
      setCart(await api.removeFromCart(sid, productId));
      track("remove_from_cart", { product_id: productId });
    },
    [sid, track],
  );

  const clearLocal = useCallback(() => setCart(empty), []);

  return (
    <CartContext.Provider value={{ cart, loading, add, update, remove, clearLocal }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  return useContext(CartContext);
}
