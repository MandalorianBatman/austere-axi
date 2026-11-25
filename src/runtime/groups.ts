// The prompt's component groups, in order. Kept apart from stock.ts so the
// component contract (define.ts), and with it the pack kit, does not pull in
// the stock OpenUI renderers.
export const GROUP_NAMES = ["Layout", "Content", "Data", "Charts", "Diagrams", "Forms", "Buttons"];

/**
 * The order of the families `components list Diagrams` files diagram types under
 * (a component's or recipe's `family`). A family not listed here comes after them.
 */
export const DIAGRAM_FAMILIES = [
  "Architecture",
  "Flow",
  "Hierarchy",
  "Data model",
  "Boards",
  "Matrices",
  "Time and plan",
  "Shapes",
  "Quantity",
];
