/** A parsed sub-component value (an Avatar inside AvatarGroup, a BreadcrumbItem, ...): its props by name. */
export interface ElementValue<Props> {
  props: Props;
}

/** Keeps values that carry props; the runtime validated them against the sub-component's schema. */
export function isElement<Props>(el: unknown): el is ElementValue<Props> {
  return typeof el === "object" && el !== null && "props" in el && Boolean(el.props);
}
