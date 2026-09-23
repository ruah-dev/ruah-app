import { Kafka } from "kafkajs";

const kafka = new Kafka({ clientId: "invoices-api", brokers: (process.env.KAFKA_BROKERS ?? "kafka:9092").split(",") });
const producer = kafka.producer();

export async function invoiceCreated(invoice) {
  await producer.connect();
  await producer.send({
    topic: "invoice.created",
    messages: [{ key: String(invoice.id), value: JSON.stringify(invoice) }],
  });
}
