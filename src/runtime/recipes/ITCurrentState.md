Write it as `Architecture(nodes, edges, lanes, "lanes")`: one Group for each phase or department, one Node for each tool, script or file share. Label hand-offs on the edge (`"CSV"`, `"Excel"`, `"email"`). Mark a pain point with tone `"danger"` and a tag (`"manual"`, `"no backup"`). Mark an outside party with kind `"external"`.

## Use for
The "before" picture of a modernization proposal: the present tools grouped by phase or department, with the manual hand-offs and the weak points visible.

## Not for
- The target system after the change: Architecture, or DPIntegration for a data platform.
- Before and after together: ArchitectureDelta.
- Who does each step of a process: ProcessMap.

## Limits
- 2 to 4 lanes, up to 5 nodes in each. More lanes scroll sideways; phones stack them as bands.
- Use `"danger"` for the few real pain points, not for every legacy tool.
- A file hand-off is an edge label; there is no file icon.

## Usual errors
- Describing the future. Keep this to what exists today.
- A tool in two lanes. Put it where it is run.
- Edge with no label. The channel (file, email, copy) is the point of this type.
- Everything in danger tone. The reader cannot tell which hurts most.
