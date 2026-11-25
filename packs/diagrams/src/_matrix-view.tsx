import { useEffect } from "react";
import { reportRuntimeError } from "austere-axi/pack";

/** Sends what the model dropped to the reviewer's panel, once for each change. */
export function useProblems(
  problems: string[],
  source: string,
  component: string,
  statementId: string | undefined,
) {
  const problemKey = problems.join("\n");
  useEffect(() => {
    for (const message of problems) reportRuntimeError({ source, statementId, component, message });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);
}
