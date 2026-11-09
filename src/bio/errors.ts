// One typed error class for all bio modules so the UI can show a friendly message per `code`.
import type { BioErrorCode } from '../shared/types';

export class BioError extends Error {
  readonly code: BioErrorCode;

  /** Creates an error with a machine-readable code and a human-readable message. */
  constructor(code: BioErrorCode, message: string) {
    super(message);
    this.name = 'BioError';
    this.code = code;
  }
}
