export class MetaPublishError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly requiresReconnect: boolean = false,
  ) {
    super(message);
    this.name = "MetaPublishError";
  }
}
