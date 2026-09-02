import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  const connection = { readyState: 1 };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        // INFRA-005: /health reports the Mongo connection state, so the
        // controller now takes the connection. Stubbed rather than spun up —
        // these cases are about what the endpoint reports, not about Mongo.
        { provide: getConnectionToken(), useValue: connection },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health (INFRA-005)', () => {
    it('HP: reports ok when Mongo is connected', () => {
      connection.readyState = 1;
      const body = appController.getHealth();
      expect(body.ok).toBe(true);
      expect(body.database).toBe('connected');
      expect(typeof body.uptimeSeconds).toBe('number');
    });

    it('EC: reports NOT ok when Mongo is disconnected', () => {
      // The reason this endpoint exists rather than pointing Render at
      // /graphql: a process that is listening but has lost its database must
      // fail the probe, or the platform routes traffic to an instance that
      // 500s every request.
      connection.readyState = 0;
      const body = appController.getHealth();
      expect(body.ok).toBe(false);
      expect(body.database).toBe('disconnected');
    });

    it('EC: reports NOT ok while still connecting', () => {
      connection.readyState = 2;
      const body = appController.getHealth();
      expect(body.ok).toBe(false);
      expect(body.database).toBe('connecting');
    });

    it('EC: an unrecognised state is named, not silently treated as ok', () => {
      connection.readyState = 99;
      const body = appController.getHealth();
      expect(body.ok).toBe(false);
      expect(body.database).toBe('unknown');
    });
  });
});
