## Use for
Who can do what: roles across, resources or components down, one access level in every cell. An access audit, a data platform's roles, a least-privilege review.

## Not for
- Who talks to what (topology, protocols): Architecture.
- How access is granted or approved: Sequence or Flowchart.
- Numbers in the cells: Heatmap.
- A list of more than 6 roles: split human roles from service accounts.

## Limits
- 6 roles, 14 resources. `check` warns above both.
- Levels are `none`, `read`, `write`, `admin`. Near words are read as the nearest: `"R/W"` and `"edit"` are write, `"SELECT"` and `"login"` are read, `"full"` and `"owner"` are admin, `"-"` and `""` are none. Any other word is printed as written, with no level style.
- The level is printed in every cell. Give every `AccessRow` one grant for each role, in role order; a missing one shows `None`.
- `focus` on an `AccessRow` names a role: that cell is ringed as the key rule ("analysts can only SELECT here"). One at most.
- `hint` is a short aside beside the resource ("S3 API").

## Usual errors
- Fewer grants than roles. The rest show `None`, which reads as a denial: count them.
- `"unknown"` or `"TBD"` for a grant. A matrix states access; leave the cell out of the claim and say so in the text.
- Putting the grant process in the cells. That is a flow, not a matrix.
- Focus on many cells. One key rule stands out; five do not.
