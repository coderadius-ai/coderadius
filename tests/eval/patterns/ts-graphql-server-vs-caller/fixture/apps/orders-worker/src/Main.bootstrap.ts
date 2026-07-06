import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './Worker.module';

// Worker process: NestFactory.createApplicationContext, NO HTTP/GraphQL server.
async function bootstrap() {
    const app = await NestFactory.createApplicationContext(WorkerModule);
    await app.init();
}

bootstrap();
