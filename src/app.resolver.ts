import { Resolver, Query } from '@nestjs/graphql';
import { AppService } from './app.service';

@Resolver()
export class AppResolver {
  constructor(private readonly appService: AppService) {}

  // A simple root query to satisfy the GraphQL compiler initialization check
  @Query(() => String, { name: 'healthCheck' })
  getHealthCheck(): string {
    return 'Backend is fully operational!';
  }
}
