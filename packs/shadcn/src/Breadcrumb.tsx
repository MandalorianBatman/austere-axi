import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

const nothing = () => null;
const safeHref = (h) => (typeof h === "string" && /^(https?:\/\/|\/|#)/i.test(h) ? h : "");

function BreadcrumbView({ props }) {
  const items = (Array.isArray(props.items) ? props.items : []).filter((el) => el && el.props);
  return (
    <nav className="sh-breadcrumb" aria-label="Breadcrumb">
      <ol>
        {items.map((el, i) => {
          const last = i === items.length - 1;
          const href = safeHref(el.props.href);
          return (
            <li key={i} data-austere-part={el.props.label}>
              {href && !last ? <a href={href}>{el.props.label}</a> : <span aria-current={last ? "page" : undefined}>{el.props.label}</span>}
              {last ? null : (
                <span className="sh-crumb-sep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export const BreadcrumbItem = austereComponent({
  name: "BreadcrumbItem",
  group: "Content",
  tier: "extended",
  props: z.object({ label: z.string(), href: z.string().optional() }),
  description: "One step of a Breadcrumb. href is optional; the last item is the current page.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Breadcrumb = austereComponent({
  name: "Breadcrumb",
  group: "Content",
  tier: "extended",
  props: z.object({ items: z.array(BreadcrumbItem.definition.ref) }),
  description: "Path trail such as Repo / Package / File, from BreadcrumbItems. Each item is a click target.",
  renderer: BreadcrumbView,
  example: `trail = Breadcrumb([repo, pkg, file])
repo = BreadcrumbItem("austere-axi")
pkg = BreadcrumbItem("packs")
file = BreadcrumbItem("shadcn")`,
});
