import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { Connection } from 'mongoose';
import { AppService } from './app.service';

/** Mongoose connection.readyState, which is a number on the wire. */
const READY_STATES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * INFRA-005 — the endpoint Render polls to decide whether this instance is
   * live and whether a new deploy may take over from the old one.
   *
   * Deliberately NOT /graphql, which the previous host was pointed at. A POST
   * -only GraphQL endpoint answers a GET health probe with a 400, and a probe
   * that reports "reachable" for a process whose database is gone is worse
   * than no probe: Render would route traffic to an instance that 500s every
   * request. So this reports the Mongo connection state, and says
   * `ok: false` when it is anything but connected.
   *
   * @SkipThrottle because Render polls this on a fixed interval for the life
   * of the service. Counting those against the shared anonymous IP bucket
   * would let the platform's own health checks rate-limit real users.
   */
  @Get('health')
  @SkipThrottle()
  getHealth(): {
    ok: boolean;
    database: string;
    uptimeSeconds: number;
  } {
    const state = this.connection.readyState;
    return {
      ok: state === 1,
      database: READY_STATES[state] ?? 'unknown',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
