import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

@Injectable()
export class ParsePositivePostgresIntegerPipe implements PipeTransform<string | number, number> {
  transform(value: string | number): number {
    if (typeof value === 'string' && !/^\d+$/.test(value)) {
      throw new BadRequestException('Lesson ID must be a positive PostgreSQL integer.');
    }

    const lessonId = Number(value);
    if (!Number.isSafeInteger(lessonId) || lessonId < 1 || lessonId > 2_147_483_647) {
      throw new BadRequestException('Lesson ID must be a positive PostgreSQL integer.');
    }

    return lessonId;
  }
}
