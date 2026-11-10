import { useState } from "react";

/** A small app with a stateful handler, the surface URL-mode specs drive. */
export const App = () => {
  const [count, setCount] = useState(0);
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
    </main>
  );
};
