import React from "react";
import { useFormName, useGetFieldValue, useIsStreaming, useSetFieldValue } from "@openuidev/react-lang";
import type { ComponentRenderProps, ComponentRenderer } from "@openuidev/react-lang";

/** The props these fields read here; the stock renderer gets them all, unchanged. */
interface FieldProps {
  name?: unknown;
  defaultValue?: unknown;
  items?: unknown;
  value?: unknown;
}

/** A CheckBoxItem or SwitchItem as the parser hands it over. */
interface ItemNode {
  props?: { name?: unknown; defaultChecked?: unknown };
}

/** What a group of checkboxes or switches shows untouched, in the shape its onChange stores. Undefined when no item says. */
function checkedDefault({ items }: FieldProps): Record<string, boolean> | undefined {
  const list: ItemNode[] = Array.isArray(items) ? items : [];
  if (!list.some((i) => typeof i?.props?.defaultChecked === "boolean")) return undefined;
  const out: Record<string, boolean> = {};
  for (const i of list) if (typeof i?.props?.name === "string") out[i.props.name] = i.props.defaultChecked === true;
  return out;
}

// Stock fields that show a default but store nothing until the reviewer changes them, so a
// Form's button sent only the answers the reviewer touched. Each entry gives the value the
// field shows untouched, in the shape the field itself stores. OptionCards and Chips store
// their default already.
const SHOWN_DEFAULT: Record<string, (props: FieldProps) => unknown> = {
  RadioGroup: ({ defaultValue }) => (typeof defaultValue === "string" && defaultValue ? defaultValue : undefined),
  Slider: ({ defaultValue }) => (Array.isArray(defaultValue) && defaultValue.length ? defaultValue : undefined),
  CheckBoxGroup: checkedDefault,
  SwitchGroup: checkedDefault,
};

/**
 * The stock renderer, plus: once the page has streamed in, a field with nothing stored yet
 * stores the default it shows, as OptionCards does. While the reviewer has not changed it, a
 * live update that changes the default stores the new one. A field bound to a $variable keeps
 * its binding. Any other component's renderer comes back as it was.
 */
export function storingShownDefault<P>(name: string, Stock: ComponentRenderer<P>): ComponentRenderer<P> {
  const shown = SHOWN_DEFAULT[name];
  if (!shown) return Stock;
  function StoresDefault(render: ComponentRenderProps<P>) {
    const props = render.props as FieldProps;
    const formName = useFormName();
    const getFieldValue = useGetFieldValue();
    const setFieldValue = useSetFieldValue();
    const isStreaming = useIsStreaming();
    const stored = React.useRef<string | undefined>(undefined); // the default this field last stored, as JSON
    const field = typeof props.name === "string" ? props.name : undefined;
    const value = field && props.value === undefined ? shown(props) : undefined;
    const key = JSON.stringify(value);
    React.useEffect(() => {
      if (isStreaming || !field || value === undefined || key === stored.current) return;
      const current = getFieldValue(formName, field);
      if (current !== undefined && JSON.stringify(current) !== stored.current) return; // the reviewer's answer
      stored.current = key;
      // false: not a reviewer edit, so nothing is saved for a reload (the page shows the default again).
      setFieldValue(formName, name, field, value, false);
      // key stands for value, which is a new array or object on every render
    }, [isStreaming, field, key, formName, getFieldValue, setFieldValue]);
    return React.createElement(Stock, render);
  }
  StoresDefault.displayName = `StoresDefault(${name})`;
  return StoresDefault;
}
