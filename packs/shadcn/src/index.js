// The shadcn pack, bundled with austere-axi: the shadcn/ui components the stock
// library lacks (no overlays, no inputs). Static, plain CSS, no Radix runtime.
import Progress from "./Progress.jsx";
import { Avatar, AvatarGroup } from "./Avatar.jsx";
import { Tooltip, HoverCard } from "./Tooltip.jsx";
import { Breadcrumb, BreadcrumbItem } from "./Breadcrumb.jsx";
import Kbd from "./Kbd.jsx";
import Skeleton from "./Skeleton.jsx";
import Calendar from "./Calendar.jsx";
import { Timeline, TimelineItem } from "./Timeline.jsx";
import css from "./shadcn.css";

export default {
  components: [Progress, Avatar, AvatarGroup, Tooltip, HoverCard, Breadcrumb, BreadcrumbItem, Kbd, Skeleton, Calendar, Timeline, TimelineItem],
  css,
};
