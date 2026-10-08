export class PicsartModelError extends Error {
  override readonly name = 'PicsartModelError';

  constructor(readonly modelId: string, message: string) {
    super(message);
  }
}

export class PicsartInputError extends Error {
  override readonly name = 'PicsartInputError';

  constructor(readonly argument: string, message: string) {
    super(message);
  }
}

export class PicsartValidationError extends Error {
  override readonly name = 'PicsartValidationError';

  constructor(readonly modelId: string, readonly errors: string[]) {
    super(`Picsart rejected the parameters for ${modelId}: ${errors.join('; ')}`);
  }
}

export class PicsartCatalogError extends Error {
  override readonly name = 'PicsartCatalogError';

  constructor(readonly url: string, readonly status: number | undefined, message: string) {
    super(message);
  }
}

export class PicsartJobFailedError extends Error {
  override readonly name = 'PicsartJobFailedError';

  constructor(readonly modelId: string, readonly generationId: string, message: string) {
    super(message);
  }
}

export class PicsartStartedJobError extends Error {
  override readonly name = 'PicsartStartedJobError';

  constructor(readonly modelId: string, readonly generationId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
