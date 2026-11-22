import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const resolutionStrategies = ['OUTSOURCE', 'WAIT_FOR_EMB_RESOURCE', 'DEPRIORITIZE_OTHER_DEMANDS'] as const;
export type ResolutionStrategy = typeof resolutionStrategies[number];

export class RecordRequestStrategyDto {
  @ApiProperty({ enum: resolutionStrategies })
  @IsIn(resolutionStrategies)
  strategy!: ResolutionStrategy;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  reason!: string;

  @ApiPropertyOptional({ type: [String], items: { type: 'string', format: 'uuid' }, maxItems: 100 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  affectedInitiativeIds?: string[];
}

export class ResolveRequestExceptionDto extends RecordRequestStrategyDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  personId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('4')
  resourceProfileId!: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsDateString({ strict: true })
  startDate!: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsDateString({ strict: true })
  endDate!: string;

  @ApiProperty({ type: Number, minimum: 0.01, maximum: 40 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 10 })
  @Min(0.01)
  @Max(40)
  weeklyHours!: number;
}
