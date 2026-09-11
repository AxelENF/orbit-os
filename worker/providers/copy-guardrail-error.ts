/**
 * Signals a guardrail rejection (budget exceeded, forbidden claim) that the
 * copy processor wants to control explicitly instead of letting the durable
 * runner's default "everything is retryable" behavior apply.
 */
export class CopyGuardrailError extends Error {
  public readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CopyGuardrailError";
    this.retryable = retryable;
  }
}
