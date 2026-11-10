/**
 * A line of copy the HMR spec rewrites on disk while the panel holds review
 * state, so an edit to it reaches the page through React Fast Refresh. It lives
 * in its own module so the edit never shifts the JSX locations in `App.tsx`
 * that other specs assert.
 */
export const Notice = () => <p id="notice">Notice: first draft</p>;
