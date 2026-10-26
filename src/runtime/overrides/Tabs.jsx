import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@openuidev/react-ui/Tabs";

// Stock Tabs follow whichever tab grew last (useful while a chat reply streams
// in), which on a static page means the last tab opens. Artifacts open on the
// first tab and keep the reader's choice across live updates.
export function StaticTabsRenderer({ props, renderNode }) {
  const items = (props.items ?? []).filter((item) => item?.props?.value != null);
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
