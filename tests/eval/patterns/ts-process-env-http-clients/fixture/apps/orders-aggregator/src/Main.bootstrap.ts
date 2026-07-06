import { OrderAggregator } from './OrderAggregator';

async function bootstrap() {
    const agg = new OrderAggregator();
    await agg.quote('SKU-1', 2);
}

bootstrap();
