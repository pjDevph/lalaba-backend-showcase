import { GraphQLFormattedError } from 'graphql';
import { formatGraphQLError } from './format-error';

/**
 * The panel branches on `extensions.code` rather than string-matching messages
 * (see api-client.ts), and alerting keys off INTERNAL_SERVER_ERROR. Both break
 * if an expected 404 is reported the same way a crash is.
 */
const err = (
  extensions: Record<string, unknown> | undefined,
): GraphQLFormattedError => ({ message: 'boom', extensions });

const withStatus = (statusCode: number, code = 'INTERNAL_SERVER_ERROR') =>
  err({ code, originalError: { statusCode } });

describe('formatGraphQLError', () => {
  describe('rewrites Apollo defaults onto the real status', () => {
    it.each([
      [400, 'BAD_REQUEST'],
      [401, 'UNAUTHENTICATED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [410, 'GONE'],
      [422, 'UNPROCESSABLE_ENTITY'],
      [429, 'TOO_MANY_REQUESTS'],
      [503, 'SERVICE_UNAVAILABLE'],
    ])('[HP] %i becomes %s', (status, expected) => {
      const out = formatGraphQLError(withStatus(status));
      expect(out.extensions?.code).toBe(expected);
    });

    it('[HP] leaves the rest of the error untouched', () => {
      const out = formatGraphQLError(withStatus(404));
      expect(out.message).toBe('boom');
      expect(out.extensions?.originalError).toEqual({ statusCode: 404 });
    });
  });

  describe('leaves everything else alone', () => {
    it('[SEC] a genuine 500 keeps INTERNAL_SERVER_ERROR', () => {
      // The honest answer for an unmapped status — never dress a crash up as
      // something a client can act on.
      const out = formatGraphQLError(withStatus(500));
      expect(out.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('[SEC] an unmapped status keeps INTERNAL_SERVER_ERROR', () => {
      expect(formatGraphQLError(withStatus(418)).extensions?.code).toBe(
        'INTERNAL_SERVER_ERROR',
      );
    });

    it.each(['MAINTENANCE_MODE', 'SESSION_REVOKED', 'MFA_REQUIRED'])(
      '[SEC] a deliberately-set %s code survives — the panel depends on it',
      (code) => {
        const out = formatGraphQLError(
          err({ code, originalError: { statusCode: 403 } }),
        );
        expect(out.extensions?.code).toBe(code);
      },
    );

    it('[EC] an error with no extensions passes through', () => {
      const out = formatGraphQLError(err(undefined));
      expect(out.extensions).toBeUndefined();
    });

    it('[EC] an error with no originalError passes through', () => {
      const out = formatGraphQLError(err({ code: 'INTERNAL_SERVER_ERROR' }));
      expect(out.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('[EC] a non-numeric statusCode passes through', () => {
      const out = formatGraphQLError(
        err({
          code: 'INTERNAL_SERVER_ERROR',
          originalError: { statusCode: '404' },
        }),
      );
      expect(out.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('[EC] GRAPHQL_VALIDATION_FAILED is not rewritten', () => {
      const out = formatGraphQLError(
        err({ code: 'GRAPHQL_VALIDATION_FAILED' }),
      );
      expect(out.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });
  });

  it('[EC] does not mutate the input', () => {
    const input = withStatus(404);
    formatGraphQLError(input);
    expect(input.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
