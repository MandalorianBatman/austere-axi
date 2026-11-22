// The Copilot CLI provides `@github/copilot-sdk` to its extensions at run time; it is not a dependency.
declare module "@github/copilot-sdk/extension" {
  export function joinSession(config?: object): Promise<import("./copilot.ts").CopilotSession>;
}
