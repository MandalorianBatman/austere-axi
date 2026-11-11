import React from "react";
import type { ComponentRenderProps } from "@openuidev/react-lang";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@openuidev/react-ui/Tabs";
import type * as UI from "@openuidev/react-ui";

// The subpath's declarations re-export "./Tabs" without an extension, which
// NodeNext resolution cannot follow; name its exports from the package root.
declare module "@openuidev/react-ui/Tabs" {
  export const Tabs: typeof UI.Tabs;
  export const TabsContent: typeof UI.TabsContent;
  export const TabsList: typeof UI.TabsList;
  export const TabsTrigger: typeof UI.TabsTrigger;
}

/** A TabItem element as the parser hands it over: TabItem(value, trigger, content). */
interface TabItemNode {
  props: { value: string; trigger?: string; content?: unknown };
}

export interface TabsProps {
  items?: ({ props?: Partial<TabItemNode["props"]> } | null | undefined)[];
}

// Stock Tabs follow whichever tab grew last (useful while a chat reply streams
// in), which on a static page means the last tab opens. Artifacts open on the
// first tab and keep the reader's choice across live updates.
export function StaticTabsRenderer({ props, renderNode }: ComponentRenderProps<TabsProps>) {
  const items = (props.items ?? []).filter((item): item is TabItemNode => item?.props?.value != null);
  const [active, setActive] = React.useState(items[0]?.props.value ?? "");
  const current = items.some((i) => i.props.value === active) ? active : items[0]?.props.value ?? "";
  if (!items.length) return null;
  return (
    <Tabs value={current} onValueChange={setActive}>
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.props.value} value={item.props.value} text={item.props.trigger} />
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.props.value} value={item.props.value}>
          {renderNode(item.props.content)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
