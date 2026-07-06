import { InfluxDB, Point } from '@influxdata/influxdb-client';

// InfluxDB v2 client: a single connection URL (http(s)://host:port) plus a token
// and bucket, all read from the environment. There is no host/port trio and no
// ORM entity — the datastore can only be recovered from the connection URL.
const url = process.env.INFLUXDB_URL ?? '';
const token = process.env.INFLUXDB_TOKEN ?? '';

const client = new InfluxDB({ url, token });
const writeApi = client.getWriteApi(
    process.env.INFLUXDB_ORG ?? '',
    process.env.INFLUXDB_BUCKET ?? '',
);

export function recordMetric(name: string, value: number): void {
    const point = new Point(name).floatField('value', value);
    writeApi.writePoint(point);
}
