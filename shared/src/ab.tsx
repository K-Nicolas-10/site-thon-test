/**
 * Client side of the testing grounds.
 *
 * This file does NOT run an experiment. It does exactly three things:
 *
 *  1. asks `/api/ab/assign` which variant this visitor is in (the decision
 *     belongs to the experiment provider behind the backend);
 *  2. reports an `exposure` event once the variant is actually rendered;
 *  3. reports named events (`click`, `add_to_cart`, `purchase`, ...) with the
 *     variant attached, so the external system can close the loop.
 *
 * Every call is fire-and-forget: if the harness is down or slow, the shop
 * keeps working. `?force=v2` overrides the assignment locally for manual
 * QA — it is reported with `source: "override"` so the experiment owner can
 * filter it out.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface Assignment {
  variant: string;
  source: string;
  unit: string;
  visitor: string;
}

export interface AbContextValue {
  assignment: Assignment | null;
  /** Report an event. No-op until the assignment has resolved. */
  track: (name: string, props?: Record<string, unknown>) => void;
}

const AbContext = createContext<AbContextValue>({ assignment: null, track: () => {} });

function visitorId(): string {
  let id = localStorage.getItem("stride.visitor");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("stride.visitor", id);
  }
  return id;
}

function sessionId(): string {
  let id = sessionStorage.getItem("stride.ab.session");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("stride.ab.session", id);
  }
  return id;
}

/** The unit under test. Variants for other units are separate experiments. */
export const AB_UNIT = "home";

export function AbProvider({
  unit = AB_UNIT,
  children,
  fallback,
}: {
  unit?: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const [assignment, setAssignment] = useState<Assignment | null>(null);

  useEffect(() => {
    const visitor = visitorId();
    const force = new URLSearchParams(location.search).get("force");
    if (force) {
      setAssignment({ variant: force, source: "override", unit, visitor });
      return;
    }
    let cancelled = false;
    fetch(`/api/ab/assign?visitor=${encodeURIComponent(visitor)}&unit=${encodeURIComponent(unit)}`)
      .then((r) => r.json())
      .then((j: { variant: string; source: string }) => {
        if (!cancelled) setAssignment({ variant: j.variant, source: j.source, unit, visitor });
      })
      .catch(() => {
        if (!cancelled) setAssignment({ variant: "unknown", source: "unavailable", unit, visitor });
      });
    return () => {
      cancelled = true;
    };
  }, [unit]);

  const track = useCallback(
    (name: string, props: Record<string, unknown> = {}) => {
      if (!assignment) return;
      const body = {
        visitor: assignment.visitor,
        session: sessionId(),
        variant: assignment.variant,
        unit: assignment.unit,
        name,
        props,
      };
      // keepalive lets purchase events survive the navigation to the
      // confirmation page.
      fetch("/api/ab/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    },
    [assignment],
  );

  useEffect(() => {
    if (assignment) track("exposure", { path: location.pathname, source: assignment.source });
    // Exposure is per mount of the app, not per route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment?.variant]);

  const value = useMemo(() => ({ assignment, track }), [assignment, track]);

  if (!assignment && fallback) return <>{fallback}</>;
  return <AbContext.Provider value={value}>{children}</AbContext.Provider>;
}

export function useAb(): AbContextValue {
  return useContext(AbContext);
}

/** Track a click on a named UI element. */
export function useTrackClick() {
  const { track } = useAb();
  const seen = useRef(new Set<string>());
  return useCallback(
    (element: string, props: Record<string, unknown> = {}, once = false) => {
      if (once) {
        if (seen.current.has(element)) return;
        seen.current.add(element);
      }
      track("click", { element, ...props });
    },
    [track],
  );
}
