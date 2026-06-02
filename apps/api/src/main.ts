import { config } from "dotenv";

// Load .env from project root (CWD may be apps/api/ when running via nest CLI)
config();
config({ path: "../../.env" });

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "*",
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`Who's the AI API listening on http://localhost:${port}`);
}

void bootstrap();
