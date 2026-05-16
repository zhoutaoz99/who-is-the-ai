import { Global, Module } from "@nestjs/common";
import { PostgresService } from "./postgres.service";
import { RedisCacheService } from "./redis-cache.service";

@Global()
@Module({
  providers: [PostgresService, RedisCacheService],
  exports: [PostgresService, RedisCacheService],
})
export class DataModule {}
