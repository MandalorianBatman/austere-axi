// The shadcn pack, bundled with austere-axi: the shadcn/ui components the stock
// library lacks (no overlays, no inputs). Static, plain CSS, no Radix runtime.
import Progress from "./Progress.tsx";
import { Avatar, AvatarGroup } from "./Avatar.tsx";
import { Tooltip, HoverCard } from "./Tooltip.tsx";
import { Breadcrumb, BreadcrumbItem } from "./Breadcrumb.tsx";
import Kbd from "./Kbd.tsx";
import Skeleton from "./Skeleton.tsx";
import Calendar from "./Calendar.tsx";
import { Timeline, TimelineItem } from "./Timeline.tsx";
import css from "./shadcn.css";
import type { PackModule } from "austere-axi/pack";

export default {
  components: [Progress, Avatar, AvatarGroup, Tooltip, HoverCard, Breadcrumb, BreadcrumbItem, Kbd, Skeleton, Calendar, Timeline, TimelineItem],
  css,
} satisfies PackModule;
