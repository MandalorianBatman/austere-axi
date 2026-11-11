// A pack written against types/pack.d.ts, as `components new` generates it.
// `npm run typecheck` keeps it compiling, so the public types cannot drift.
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";
import type { AustereComponent, PackModule } from "austere-axi/pack";

function MilestonesView({ props }: { props: { events: string[] } }) {
  return props.events.length;
}

// A value-only part nested through definition.ref: the container's renderer sees the part's props typed.
const Step = austereComponent({
  name: "Step",
  group: "Content",
  props: z.object({ label: z.string() }),
  description: "One step.",
  renderer: () => null,
  slots: null,
});

const Steps = austereComponent({
  name: "Steps",
  group: "Content",
  props: z.object({ steps: z.array(Step.definition.ref) }),
  description: "Steps in order.",
  renderer: ({ props }) => props.steps.map((s) => s.props.label.toUpperCase()),
  example: `plan = Steps([a])\na = Step("Freeze")`,
});

austereComponent({
  name: "BadSteps",
  group: "Content",
  props: z.object({ steps: z.array(Step.definition.ref) }),
  description: "x",
  // @ts-expect-error a nested part's props are typed (definition.ref is not any)
  renderer: ({ props }) => props.steps.map((s) => s.props.nope),
  example: `plan = BadSteps([])`,
});

// Components with different props share one list.
const all: AustereComponent[] = [Step, Steps];

const pack: PackModule = {
  components: [
    ...all,
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
export default pack;

// A wrong prop type must fail the type check.
// @ts-expect-error name is a string
austereComponent({ name: 1, group: "Content", props: z.object({}), description: "x", renderer: () => null, example: "" });
