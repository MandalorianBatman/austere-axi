// @ts-check
// A pack written against types/pack.d.ts, as `components new` generates it.
// `npm run typecheck` keeps it compiling, so the public types cannot drift.
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

/** @param {{ props: { events: string[] } }} args */
function MilestonesView({ props }) {
  return props.events.length;
}

export default {
  components: [
    austereComponent({
      name: "Milestones",
      group: "Content",
      props: z.object({ events: z.array(z.string()) }),
      description: "Vertical milestones.",
      renderer: MilestonesView,
      example: `launch = Milestones(["Mon | Freeze"])`,
    }),
  ],
  css: "",
};

// A wrong prop type must fail the type check.
// @ts-expect-error name is a string
austereComponent({ name: 1, group: "Content", props: z.object({}), description: "x", renderer: () => null, example: "" });
