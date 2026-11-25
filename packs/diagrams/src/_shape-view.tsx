import React from "react";

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and the next one together.
export const T = ({
  children,
  ...rest
}: React.SVGProps<SVGTextElement> & { children?: React.ReactNode }) => (
  <text {...rest}>{children} </text>
);

/** A transparent rectangle that takes the click for a thin part (a label, a line). */
export function Hit({ x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }) {
  return (
    <rect
      className="dg-sh-hit"
      x={x0}
      y={y0}
      width={Math.max(0, x1 - x0)}
      height={Math.max(0, y1 - y0)}
    />
  );
}

export const noShapes = (what: string, how: string) => (
  <div className="austere-render-error">
    <strong>{what}</strong> {how}
  </div>
);
