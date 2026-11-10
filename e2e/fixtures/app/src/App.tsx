import { FixtureWidget } from "fixture-widget";
import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * A full-viewport layer at the highest `z-index` an app can set, portalled to
 * the end of `<body>` so it comes after the overlay's host in paint order.
 */
const ZIndexWall = () =>
  createPortal(
    <div
      id="z-wall"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "rgba(220, 38, 38, 0.12)",
      }}
    />,
    document.body,
  );

/** A small app with a stateful handler, the surface URL-mode specs drive. */
export const App = () => {
  const [count, setCount] = useState(0);
  const [wall, setWall] = useState(false);
  return (
    <main>
      <h1 id="headline">Fixture app</h1>
      <button
        id="counter"
        type="button"
        onClick={() => setCount((value) => value + 1)}
      >
        Clicked {count} times
      </button>
      <button id="raise-wall" type="button" onClick={() => setWall(true)}>
        Raise the z-index wall
      </button>
      <section id="widget-slot">
        <FixtureWidget />
      </section>
      {wall && <ZIndexWall />}
    </main>
  );
};
