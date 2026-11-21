import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { AgentAnalysisService } from "./agent-analysis.service.js";
/** Shared control-plane dispatcher. Agents never construct or receive model clients. */
export function consumeAnalysis(
  region: string,
  queueUrl: string,
  service: AgentAnalysisService,
) {
  const sqs = new SQSClient({
      region,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 25000 },
    }),
    controller = new AbortController();
  let stopped = false;
  const task = (async () => {
    while (!stopped) {
      try {
        const batch = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 180,
          }),
          { abortSignal: controller.signal },
        );
        for (const m of batch.Messages ?? []) {
          try {
            await service.process(JSON.parse(m.Body ?? "null"));
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: m.ReceiptHandle!,
              }),
            );
          } catch (e) {
            console.warn(
              JSON.stringify({
                event: "analysis.dispatch.failed",
                errorType: (e as Error).name,
              }),
            );
          }
        }
      } catch (e) {
        if (stopped) break;
        console.warn(
          JSON.stringify({
            event: "analysis.queue.unavailable",
            errorType: (e as Error).name,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();
  return async () => {
    stopped = true;
    controller.abort();
    await task;
    sqs.destroy();
  };
}
