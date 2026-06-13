import { config } from "dotenv";

// Load .env from project root (CWD may be apps/api/ when running via nest CLI)
config();
config({ path: "../../.env" });

import { LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logLevels = (process.env.LOG_LEVELS ?? 'log,error,warn').split(
    ',',
  ) as LogLevel[];

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: logLevels,
  });
  app.useBodyParser("json", { limit: "5mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "5mb" });
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "*",
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
  console.log(`Who's the AI API listening on http://0.0.0.0:${port}`);
}

void bootstrap();
