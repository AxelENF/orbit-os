export interface PublishProviderInput<Payload = unknown> {
  organizationId: string;
  payload: Payload;
}

export interface PublishProvider<Payload = unknown, Result = unknown> {
  publish(input: PublishProviderInput<Payload>): Promise<Result>;
}

export type LocalPublisher<Payload = unknown, Result = unknown> =
  (input: PublishProviderInput<Payload>) => Promise<Result> | Result;

/**
 * Adapter for a caller-owned local function. Publication to Meta and routing
 * through n8n remain explicit future integration escapes, not worker behavior.
 */
export class LocalPublishProviderAdapter<Payload = unknown, Result = unknown>
  implements PublishProvider<Payload, Result>
{
  public constructor(private readonly publisher: LocalPublisher<Payload, Result>) {}

  public async publish(input: PublishProviderInput<Payload>): Promise<Result> {
    return this.publisher(input);
  }
}
