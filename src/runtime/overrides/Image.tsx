import React from "react";
import type { ComponentRenderProps } from "@openuidev/react-lang";

export interface ImageProps {
  alt?: string;
  src?: string;
}

// Stock Image boxes every picture in a 3:2 frame and crops it to fill (object-fit: cover),
// which cuts the edges off diagrams, screenshots and illustrations. A review page shows
// the whole picture at its own aspect ratio, as wide as its column. Once loaded, its ratio
// lets CSS narrow a tall picture so it fits the screen height (austere.css). A picture
// that fails to load stays visible as the browser's broken-image mark with its alt text.
export function WholeImageRenderer({ props }: ComponentRenderProps<ImageProps>) {
  const [ratio, setRatio] = React.useState<number>();
  return (
    <img
      className="openui-image austere-image"
      src={props.src || undefined}
      alt={props.alt ?? ""}
      style={ratio ? ({ "--austere-image-ratio": ratio } as React.CSSProperties) : undefined}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight);
      }}
    />
  );
}
