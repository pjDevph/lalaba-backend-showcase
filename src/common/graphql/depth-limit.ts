import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type ValidationContext,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

// Dependency-free query-depth limit, implemented as a GraphQL validation rule.
// Rejects excessively nested queries BEFORE execution — a cheap guard against
// abusive or accidental expensive queries. (Introspection is already disabled,
// which hides the schema but does nothing to bound query depth.)
//
// Fragments are traversed transparently (they don't add a depth level); only
// fields do. Cyclic fragment spreads are guarded so this can't recurse forever.
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(node: OperationDefinitionNode) {
      const depth = selectionSetDepth(node.selectionSet, context, new Set());
      if (depth > maxDepth) {
        context.reportError(
          new GraphQLError(
            `Query exceeds the maximum allowed depth of ${maxDepth} (got ${depth}).`,
            { nodes: [node] },
          ),
        );
      }
    },
  });
}

function selectionSetDepth(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  visitedFragments: Set<string>,
): number {
  let max = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const childDepth = selection.selectionSet
        ? selectionSetDepth(selection.selectionSet, context, visitedFragments)
        : 0;
      max = Math.max(max, 1 + childDepth);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (selection.selectionSet) {
        max = Math.max(
          max,
          selectionSetDepth(selection.selectionSet, context, visitedFragments),
        );
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (visitedFragments.has(name)) continue; // cyclic fragment — stop
      const fragment = context.getFragment(name);
      if (fragment) {
        visitedFragments.add(name);
        max = Math.max(
          max,
          selectionSetDepth(fragment.selectionSet, context, visitedFragments),
        );
        visitedFragments.delete(name);
      }
    }
  }
  return max;
}
