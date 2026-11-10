import { jsx, jsxs } from "react/jsx-runtime";
import { createPortal } from "react-dom";

/**
 * A stand-in for a third-party popover or menu: published JavaScript compiled
 * with the production JSX runtime, the way libraries ship, that portals its
 * content to the end of `<body>` like most dropdowns, tooltips and dialogs do.
 * None of its elements carry intervu's source stamp.
 */
export const PortalWidget = () =>
  createPortal(
    jsxs("div", {
      className: "portal-widget",
      children: [
        jsx("span", { id: "portal-label", children: "Portalled widget" }),
      ],
    }),
    document.body,
  );
