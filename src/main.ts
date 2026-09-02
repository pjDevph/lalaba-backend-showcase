import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getConnectionToken } from '@nestjs/mongoose';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AppModule } from './app.module';
import { isOnlineMongoMode } from './common/utils/mongo-env.util';
import { assertRequiredEnv } from './config/env.validation';

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// The base64 upload paths (courier selfie, KYC, washer cert proof, media) each
// cap the payload at 7 MB in their own service. body-parser's 100 KB default
// rejected those requests long before that check could run, so the caps were
// unreachable and every real image 413'd. Sized to clear 7 MB of base64 plus
// the surrounding GraphQL envelope; the per-service caps remain the real limit.
const BODY_LIMIT = '10mb';

const READY_STATES: Record<number, string> = {
  0: 'Disconnected',
  1: 'Connected',
  2: 'Connecting',
  3: 'Disconnecting',
};

async function bootstrap() {
  // Fail fast on missing required env in production (warn-only in dev).
  // Runs before NestFactory.create so a misconfigured prod deploy aborts
  // immediately instead of hanging on a DB connect. AppModule's import above
  // already ran ConfigModule.forRoot(), so .env is loaded at this point.
  assertRequiredEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // SEC-001 — trust exactly one proxy hop (Render's load balancer).
  //
  // Render terminates TLS at its balancer and forwards to this service, so
  // without this Express reports the balancer's address as `req.ip` for every
  // request on the internet. The throttler keys on that, which collapsed all
  // traffic worldwide into a single 100-req/minute bucket: no attacker was
  // ever limited, and a few dozen concurrent users 429'd each other off.
  //
  // The hop count is 1, not `true`. `true` trusts the entire X-Forwarded-For
  // chain, so a caller can prepend a forged address and choose their own
  // rate-limit bucket. 1 takes the single entry Render's balancer appends and
  // ignores anything the client sent ahead of it.
  app.set('trust proxy', 1);

  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  // Route all NestJS logs (startup, errors) through Winston
  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(logger);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.enableCors({
    origin:
      process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) ?? false,
    credentials: true,
  });

  // INFRA-009 — let Nest run onModuleDestroy/onApplicationShutdown hooks.
  //
  // Render sends SIGTERM to the old instance on every deploy and waits before
  // SIGKILL. Without this the process dies mid-request: Mongo sessions are not
  // closed and in-flight work is cut wherever it happens to be. Most paths are
  // transactional and roll back cleanly, but a wallet credit interrupted
  // between the $inc and the ledger append is exactly the drift
  // walletReconciliationReport exists to catch — so don't create it.
  app.enableShutdownHooks();

  const connection = app.get(getConnectionToken());
  connection.on('disconnected', () =>
    logger.warn('MongoDB Disconnected', 'Database'),
  );
  connection.on('reconnected', () =>
    logger.log('MongoDB Reconnected', 'Database'),
  );
  connection.on('error', (err: any) =>
    logger.error(`MongoDB Error: ${err?.message}`, undefined, 'Database'),
  );

  // INFRA-003 — Render routes to the port it injects, and only reaches the
  // service if it is bound on all interfaces. Node's default binding is fine
  // locally and invisible in dev; on Render a loopback-only bind fails the
  // health check with no error of its own.
  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');

  const mongoEnv = isOnlineMongoMode() ? 'ONLINE (Atlas)' : 'LOCAL (Docker)';
  logger.log(
    `MongoDB ${READY_STATES[connection.readyState] ?? 'Unknown'} — ${mongoEnv} — host: ${connection.host}/${connection.name}`,
    'Database',
  );
  logger.log(`Server running on port ${port}`, 'Bootstrap');
}
void bootstrap();
