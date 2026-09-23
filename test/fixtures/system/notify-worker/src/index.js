import { Kafka } from "kafkajs";
import { Resend } from "resend";

const kafka = new Kafka({ clientId: "notify-worker", brokers: ["kafka:9092"] });
const consumer = kafka.consumer({ groupId: "notify-worker" });
const resend = new Resend(process.env.RESEND_API_KEY);

await consumer.connect();
await consumer.subscribe({ topic: "invoice.created", fromBeginning: false });
await consumer.run({
  eachMessage: async ({ message }) => {
    const invoice = JSON.parse(String(message.value));
    await resend.emails.send({ to: invoice.email, subject: `Invoice ${invoice.id}`, text: "Thanks!" });
  },
});
