import { BadRequestException, PipeTransform } from '@nestjs/common';

/**
 * Length-caps a SCALAR GraphQL argument.
 *
 * class-validator's @MaxLength only runs on @InputType object arguments, so a
 * mutation taking a bare `@Args('body') body: string` is validated by nothing
 * at all — which is how the support-ticket reply ended up uncapped while the
 * ticket it belongs to was capped.
 *
 * Trims first, so a message of pure whitespace is rejected as empty rather
 * than stored as a blank note.
 */
export class MaxLengthPipe implements PipeTransform<string, string> {
  constructor(
    private readonly max: number,
    private readonly field = 'value',
    private readonly allowEmpty = false,
  ) {}

  transform(value: string): string {
    const trimmed = (value ?? '').trim();
    if (!this.allowEmpty && trimmed.length === 0) {
      throw new BadRequestException(`${this.field} cannot be empty.`);
    }
    if (trimmed.length > this.max) {
      throw new BadRequestException(
        `${this.field} cannot be longer than ${this.max} characters.`,
      );
    }
    return trimmed;
  }
}
