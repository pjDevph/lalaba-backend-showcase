import { GraphQLFormattedError } from 'graphql';

/**
 * Maps the HTTP status of a Nest exception onto a meaningful GraphQL
 * `extensions.code`.
 *
 * Apollo assigns `INTERNAL_SERVER_ERROR` to any error that does not carry an
 * explicit code, and a plain `NotFoundException` does not carry one — so
 * "Order not found" reached clients tagged the same as a genuine crash. That
 * matters twice over: `api-client.ts` exists specifically to branch on
 * `extensions.code` rather than string-match messages, and alerting that keys
 * off INTERNAL_SERVER_ERROR fires on every mistyped ID.
 *
 * Only rewrites errors Apollo has ALREADY defaulted to INTERNAL_SERVER_ERROR.
 * Anything that set its own code — GqlAuthGuard's MAINTENANCE_MODE, the
 * SESSION_REVOKED the panel signs out on — is left exactly as thrown.
 */
const STATUS_TO_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

export function formatGraphQLError(
  formatted: GraphQLFormattedError,
): GraphQLFormattedError {
  const extensions = formatted.extensions;
  if (!extensions || extensions.code !== 'INTERNAL_SERVER_ERROR') {
    return formatted;
  }

  const original = extensions.originalError as
    { statusCode?: number } | undefined;
  const status = original?.statusCode;
  if (typeof status !== 'number') return formatted;

  const code = STATUS_TO_CODE[status];
  // A real 500 has no entry here and keeps INTERNAL_SERVER_ERROR, which is
  // the honest answer for it.
  if (!code) return formatted;

  return { ...formatted, extensions: { ...extensions, code } };
}
