import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

function KbdView({ props }) {
  const keys = String(props.keys ?? "")
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean);
  return (
    <span className="sh-kbd-group">
      {keys.map((k, i) => (
        <kbd key={i} className="sh-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export default austereComponent({
  name: "Kbd",
  group: "Content",
  tier: "extended",
  props: z.object({ keys: z.string() }),
  description: 'Keyboard shortcut. keys joins keys with "+", e.g. "Ctrl+K"; each key is drawn as a key cap.',
  renderer: KbdView,
  example: `shortcut = Kbd("Ctrl+Shift+P")`,
});
