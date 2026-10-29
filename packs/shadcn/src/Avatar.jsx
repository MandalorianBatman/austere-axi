import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

const initials = (name) =>
  String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";

/** Only https and data: images; anything else falls back to initials. */
const safeSrc = (src) => (typeof src === "string" && /^(https:\/\/|data:image\/)/i.test(src) ? src : "");

function Face({ name, src, size }) {
  const url = safeSrc(src);
  return (
    <span className={`sh-avatar sh-avatar-${size === "lg" ? "lg" : "md"}`} title={name} data-austere-part={name || undefined}>
      {url ? <img src={url} alt={name || ""} /> : <span aria-hidden="true">{initials(name)}</span>}
    </span>
  );
}

function AvatarView({ props }) {
  return <Face name={props.name} src={props.src} size={props.size} />;
}

export const Avatar = austereComponent({
  name: "Avatar",
  group: "Data",
  tier: "extended",
  props: z.object({ name: z.string(), src: z.string().optional(), size: z.enum(["md", "lg"]).optional() }),
  description: "Round avatar for a person. Shows the initials of name; src is an optional https image URL.",
  renderer: AvatarView,
  example: `owner = Avatar("Ada Lovelace")`,
});

function AvatarGroupView({ props }) {
  const list = (Array.isArray(props.avatars) ? props.avatars : []).filter((el) => el && el.props);
  const max = Number.isInteger(props.max) && props.max > 0 ? props.max : 4;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <span className="sh-avatar-group">
      {shown.map((el, i) => (
        <Face key={i} name={el.props.name} src={el.props.src} size={el.props.size} />
      ))}
      {rest > 0 ? <span className="sh-avatar sh-avatar-md sh-avatar-more">+{rest}</span> : null}
    </span>
  );
}

export const AvatarGroup = austereComponent({
  name: "AvatarGroup",
  group: "Data",
  tier: "extended",
  props: z.object({ avatars: z.array(Avatar.definition.ref), max: z.number().int().optional() }),
  description: "Overlapping Avatars, for reviewers or owners. max (default 4) shows the rest as +N.",
  renderer: AvatarGroupView,
  example: `team = AvatarGroup([ada, grace, linus], 2)
ada = Avatar("Ada Lovelace")
grace = Avatar("Grace Hopper")
linus = Avatar("Linus Torvalds")`,
});
