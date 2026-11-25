import React from "react";
import { z } from "zod";
import { useFormName, useTriggerAction } from "@openuidev/react-lang";
import type { ComponentRenderProps } from "@openuidev/react-lang";
import { OverviewCardBlock } from "@openuidev/react-ui/OverviewCardBlock";
import type * as UI from "@openuidev/react-ui";

declare module "@openuidev/react-ui/OverviewCardBlock" {
  export const OverviewCardBlock: typeof UI.OverviewCardBlock;
}

// Stock MetricIndicatorInline colours a falling trend red and a rising one green, so a cost that
// fell 24% reads as bad news and tickets that rose 340% as good. `better` says which way is good;
// the stock props stay in their order and `better` is appended (it is optional, default "up").
export const MetricInlineProps = z.object({
  value: z.string(),
  subtext: z.string().optional(),
  trend: z.object({ direction: z.enum(["up", "down"]), value: z.number() }).optional(),
  better: z.enum(["up", "down"]).optional(),
});

export const METRIC_INLINE_DESCRIPTION =
  'Headline metric value with an optional +/- percentage trend and subtext, on one line. better: "down" when a fall is good (cost, errors, latency); the trend is green when it moves toward better.';

export type MetricInline = z.infer<typeof MetricInlineProps>;

export function MetricInlineRenderer({ props }: ComponentRenderProps<MetricInline>) {
  const { value, subtext, trend, better } = props;
  const good = trend ? trend.direction === (better ?? "up") : false;
  return (
    <div
      className={`openui-metric-indicator openui-metric-indicator--variant-inline${subtext ? " openui-metric-indicator--has-subtext" : ""}`}
    >
      <div className="openui-metric-indicator__row">
        <div className="openui-metric-indicator__main-value">{value}</div>
        {trend ? (
          <div
            className={`openui-metric-indicator__trend openui-metric-indicator__trend--${good ? "success" : "danger"}`}
          >
            {trend.direction === "up" ? "+" : "-"}
            {trend.value}%<span className="austere-sr-only">{good ? " (better)" : " (worse)"}</span>
          </div>
        ) : null}
        {subtext ? <div className="openui-metric-indicator__subtext">{subtext}</div> : null}
      </div>
    </div>
  );
}

export interface OverviewBlockProps {
  items?: unknown[];
  layout?: "grid" | "carousel";
  responsive?: boolean;
  gap?: number | string;
  action?: unknown;
}

// Stock OverviewCardBlock draws each item's metric itself, from the trend alone, so `better` never
// reaches the metric above. This renderer is the stock block with the metric drawn by ours.
interface OverviewItemNode {
  props: { id?: string; top?: unknown; bottom?: { props: MetricInline } };
}

export function OverviewBlockRenderer({
  props,
  renderNode,
}: ComponentRenderProps<OverviewBlockProps>) {
  const triggerAction = useTriggerAction();
  const formName = useFormName();
  const items = (props.items ?? []) as OverviewItemNode[];
  const click = props.action
    ? (_item: unknown, index: number) => {
        const item = items[index];
        const top = item?.props.top as { props?: Record<string, unknown> } | undefined;
        const title = String(top?.props?.title ?? top?.props?.value ?? item?.props.id ?? "");
        triggerAction(title || `Overview card ${index + 1}`, formName, props.action as never);
      }
    : undefined;
  return (
    <OverviewCardBlock
      layout={props.layout ?? "grid"}
      responsive={props.responsive !== false}
      gap={props.gap}
      clickable={!!click}
      onItemClick={click}
      items={items.map((item) => ({
        id: item.props.id,
        top: (
          <div className="austere-metric-stack">
            {item.props.top ? renderNode(item.props.top) : null}
            {item.props.bottom ? (
              <div className="openui-overview-card__slot openui-overview-card__slot--bottom">
                <MetricInlineRenderer
                  {...({ props: item.props.bottom.props } as ComponentRenderProps<MetricInline>)}
                />
              </div>
            ) : null}
          </div>
        ),
      }))}
    />
  );
}
