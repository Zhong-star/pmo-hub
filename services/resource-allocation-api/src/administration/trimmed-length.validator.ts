import { registerDecorator, type ValidationOptions } from 'class-validator';

export function IsTrimmedLength(min: number, max?: number, options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isTrimmedLength',
      target: target.constructor,
      propertyName,
      constraints: [min, max],
      options,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const length = value.trim().length;
          return length >= min && (max === undefined || length <= max);
        },
        defaultMessage() {
          return max === undefined
            ? `The value must contain at least ${min} non-space characters.`
            : `The value must contain between ${min} and ${max} characters after trimming.`;
        },
      },
    });
  };
}
