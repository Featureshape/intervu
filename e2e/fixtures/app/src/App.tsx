import { FixtureWidget } from "fixture-widget";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Notice } from "./Notice.tsx";

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

/**
 * A small app with a stateful handler and a second, client-side route, the
 * surface URL-mode specs drive.
 */
export const App = () => {
  const [count, setCount] = useState(0);
  const [wall, setWall] = useState(false);
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const follow = () => setPath(window.location.pathname);
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  return (
    <main>
      <h1 id="headline">Fixture app</h1>
      <Notice />
      <nav>
        <a
          id="nav-about"
          href="/about"
          onClick={(event) => {
            event.preventDefault();
            window.history.pushState(null, "", "/about");
            setPath("/about");
          }}
        >
          About
        </a>
      </nav>
      {path === "/about" && (
        <article>
          <p>About the fixture app.</p>
        </article>
      )}
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
