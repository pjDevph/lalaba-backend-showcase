import {
  ArgumentsHost,
  Catch,
  HttpException,
  Inject,
  InternalServerErrorException,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

@Catch()
export class GlobalExceptionFilter implements GqlExceptionFilter {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType<'graphql' | 'http'>() !== 'graphql') {
      return this.catchHttp(exception, host);
    }

    const gqlHost = GqlArgumentsHost.create(host);
    const info = gqlHost.getInfo();
    const operation = info
      ? `${info.parentType?.name}.${info.fieldName}`
      : 'unknown';

    if (exception instanceof HttpException) {
      // Expected, user-facing errors (validation, not found, forbidden, etc.)
      const status = exception.getStatus();
      this.logger.warn(
        `${operation} failed (${status}): ${exception.message}`,
        {
          context: 'GraphQL',
        },
      );
      return exception;
    }

    if (exception instanceof GraphQLError) {
      // Deliberately thrown with custom `extensions` (e.g. GqlAuthGuard's
      // MAINTENANCE_MODE block) — an expected, user-facing error whose
      // extensions the client depends on, same trust level as an
      // HttpException above. Passing it through unmodified is what keeps
      // those extensions intact; falling into the branch below would
      // flatten it to a generic 500 and lose them.
      this.logger.warn(`${operation} failed: ${exception.message}`, {
        context: 'GraphQL',
      });
      return exception;
    }

    // Unexpected runtime errors — log full stack for incident review, but
    // NEVER hand the raw object back to Apollo (SEC-003). Returning the
    // original error leaks its message (Mongo/driver internals, cast failures,
    // connection strings) and, whenever Apollo's stacktrace inclusion is on,
    // the full stack with absolute node_modules paths. The client gets a
    // generic 500 instead; the detail lives only in the server log.
    const err = exception as Error;
    this.logger.error(`Unhandled error in ${operation}: ${err?.message}`, {
      context: 'GraphQL',
      stack: err?.stack,
    });
    return new InternalServerErrorException('Internal server error');
  }

  /**
   * Returning the exception is how a GraphQL filter hands control back to
   * Apollo, but on a plain HTTP route nothing then writes a response and the
   * request hangs until the caller times out. REST routes (POST
   * /webhooks/xendit) must get a real status code — a hung callback makes
   * Xendit retry a request the server already rejected.
   */
  private catchHttp(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();
    const route = `${req?.method ?? '?'} ${req?.url ?? '?'}`;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      this.logger.warn(`${route} failed (${status}): ${exception.message}`, {
        context: 'HTTP',
      });
      return res.status(status).json(exception.getResponse());
    }

    const err = exception as Error;
    this.logger.error(`Unhandled error in ${route}: ${err?.message}`, {
      context: 'HTTP',
      stack: err?.stack,
    });
    return res
      .status(500)
      .json({ statusCode: 500, message: 'Internal server error' });
  }
}
