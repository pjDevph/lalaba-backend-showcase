import { Inject } from '@nestjs/common';
import { Plugin } from '@nestjs/apollo';
import { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

@Plugin()
export class GraphQLLoggingPlugin implements ApolloServerPlugin {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener<any>> {
    const start = Date.now();
    const logger = this.logger;

    return {
      // Fires once the operation has been parsed/validated and named
      async didResolveOperation(ctx) {
        const op = ctx.operation?.operation ?? 'operation';
        const name = ctx.operationName ?? 'anonymous';
        logger.debug(`→ ${op} ${name}`, { context: 'GraphQL' });
      },

      // Fires when the request is fully resolved (success or error)
      async willSendResponse(ctx) {
        const ms = Date.now() - start;
        const name = ctx.operationName ?? 'anonymous';
        const errors = ctx.errors ?? [];

        if (errors.length) {
          logger.warn(`✗ ${name} (${ms}ms) — ${errors.length} error(s)`, {
            context: 'GraphQL',
          });
        } else {
          logger.info(`✓ ${name} (${ms}ms)`, { context: 'GraphQL' });
        }
      },
    };
  }
}
