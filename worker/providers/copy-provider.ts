export interface CopyProviderInput<Payload = unknown> {
  organizationId: string;
  payload: Payload;
}

export interface CopyProvider<Payload = unknown, Result = unknown> {
  generate(input: CopyProviderInput<Payload>): Promise<Result>;
}

export type LocalCopyGenerator<Payload = unknown, Result = unknown> =
  (input: CopyProviderInput<Payload>) => Promise<Result> | Result;

/**
 * Adapter for a caller-owned local function. It deliberately does not invoke
 * n8n, OpenRouter, Meta, or any other external service.
 */
export class LocalCopyProviderAdapter<Payload = unknown, Result = unknown>
  implements CopyProvider<Payload, Result>
{
  public constructor(private readonly generator: LocalCopyGenerator<Payload, Result>) {}

  public async generate(input: CopyProviderInput<Payload>): Promise<Result> {
    return this.generator(input);
  }
}
