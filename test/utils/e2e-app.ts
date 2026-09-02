/**
 * Shared harness that boots the REAL Nest application for e2e specs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The unit suite (318 specs) instantiates services directly and never builds
 * the application. That is exactly the blind spot that let three defects ship:
 *   1. f9615aa — a `Date | null` @Field() made GraphQL schema construction
 *      fail, so the app could not boot at all.
 *   2. 211fe3d — the globally-registered GqlThrottlerGuard crashed on every
 *      plain-HTTP request, killing GET / and POST /webhooks/xendit.
 *   3. 211fe3d — the global exception filter returned instead of responding on
 *      HTTP, so rejected webhooks hung rather than answering 401.
 * None of the three is reachable without `createNestApplication()` + `init()`
 * and a real HTTP round trip, which is what this helper provides.
 *
 * WHAT IS REAL vs SUBSTITUTED
 * ---------------------------
 * Real: the whole AppModule graph, GraphQL schema construction, the global
 * throttler guard, the global exception filter, the global ValidationPipe, the
 * activity-logging interceptor, every resolver/controller, and MongoDB (an
 * in-memory replica set, so transactions work).
 * Substituted: FirebaseService only — the real one calls
 * `admin.initializeApp()` in onModuleInit and needs a service-account key that
 * is not in git. The fake resolves an id token to the uid it literally
 * contains, so specs authenticate as `Bearer <uid>`.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../../src/app.module';
import { FirebaseService } from '../../src/firebase/firebase.service';

/**
 * Stand-in for FirebaseService. `verifyIdToken` treats the bearer token as the
 * uid itself, and rejects the reserved token 'invalid' so specs can assert the
 * unauthenticated path too.
 */
export class FakeFirebaseService {
  readonly sentMessages: unknown[] = [];

  getAuth() {
    return {
      verifyIdToken: (token: string) => {
        if (!token || token === 'invalid') {
          return Promise.reject(new Error('Firebase ID token is invalid'));
        }
        return Promise.resolve({ uid: token });
      },
    };
  }

  getMessaging() {
    return {
      send: (msg: unknown) => {
        this.sentMessages.push(msg);
        return Promise.resolve('fake-message-id');
      },
      sendEachForMulticast: (msg: unknown) => {
        this.sentMessages.push(msg);
        return Promise.resolve({
          successCount: 1,
          failureCount: 0,
          responses: [],
        });
      },
    };
  }

  getStorageBucket() {
    throw new Error('Firebase Storage is not available in e2e');
  }

  sendPasswordResetEmail() {
    return Promise.resolve();
  }
}

export interface E2EContext {
  app: INestApplication;
  moduleRef: TestingModule;
  connection: Connection;
  firebase: FakeFirebaseService;
  close: () => Promise<void>;
}

/**
 * Builds and initialises the application. Global pipes mirror src/main.ts so
 * the e2e app validates input exactly like production does.
 */
export async function createE2EApp(): Promise<E2EContext> {
  const firebase = new FakeFirebaseService();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(FirebaseService)
    .useValue(firebase)
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const connection = app.get<Connection>(getConnectionToken());

  return {
    app,
    moduleRef,
    connection,
    firebase,
    close: async () => {
      await app.close();
    },
  };
}
