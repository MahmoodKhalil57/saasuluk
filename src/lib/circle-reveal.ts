/**
 * Expanding-circle reveal (View Transitions API) originating from a clicked element — the same effect saasuluk's theme
 * toggle + color-scheme picker use. Captures the origin point SYNCHRONOUSLY (before `mutate` can detach the element, so
 * the circle starts at the click, not 0,0), then animates a clip-path circle on `::view-transition-new(root)`. Falls
 * back to an instant mutate when the browser lacks `startViewTransition` or the user prefers reduced motion. The
 * "only the circle plays" CSS (suppressing the default cross-fade) lives in Layout's global styles.
 */
type Point = { x: number; y: number };

export function circleReveal(origin: Element | Point | null | undefined, mutate: () => void): void {
  const reduce = typeof window !== "undefined" && !!window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let pt: Point | null = null;
  if (origin && typeof (origin as Element).getBoundingClientRect === "function") {
    const r = (origin as Element).getBoundingClientRect();
    if (r.width || r.height) pt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } else if (origin && typeof (origin as Point).x === "number") {
    pt = origin as Point;
  }

  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || !pt || reduce) {
    mutate();
    return;
  }

  const { x, y } = pt;
  doc
    .startViewTransition(mutate)
    .ready.then(() => {
      const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
        { duration: 480, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}
