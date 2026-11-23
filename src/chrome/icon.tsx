// The icons of icons.ts (the review page's and the hub's, drawn from the redesign) as React elements.
import { createElement } from "react";
import type { ReactElement } from "react";
import { ICONS } from "./icons.ts";
import type { IconName, Shape } from "./icons.ts";

interface IconOptions {
  /** Width and height in CSS px. */
  size?: number;
  /** Stroke width. */
  width?: number;
  /** Makes the icon meaningful (role="img"); without it the icon is decorative (aria-hidden). */
  label?: string;
  cls?: string;
}

const camel = (k: string): string => k.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** An icon from shapes a module defines for itself (see ICONS for the format). */
export function ShapeIcon({
  shapes,
  size = 16,
  width = 1.7,
  label,
  cls,
}: IconOptions & { shapes: readonly Shape[] }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon${cls ? ` ${cls}` : ""}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {shapes.map(([tag, attrs], i) =>
        createElement(tag, {
          key: i,
          ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [camel(k), v])),
        }),
      )}
    </svg>
  );
}

export function Icon({ name, ...options }: IconOptions & { name: IconName }): ReactElement {
  return <ShapeIcon shapes={ICONS[name]} {...options} />;
}
