import { instanceToPlain, plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import { DateFormat, formatDateValue } from './date-format.decorator.js';

class DateDto {
  @DateFormat()
  value: unknown;
}

describe('日期格式化', () => {
  it.each([
    { value: null, expected: null },
    { value: undefined, expected: undefined },
    { value: 123, expected: 123 },
    { value: 'invalid date', expected: 'invalid date' },
    { value: '2026-10-21T00:00:00Z', expected: '2026-10-21 08:00:00' },
    { value: new Date('2026-10-21T00:00:00Z'), expected: '2026-10-21 08:00:00' },
  ])('函数与双向 DTO 转换保留约定结果：$value', ({ value, expected }) => {
    expect(formatDateValue(value)).toEqual(expected);
    expect(plainToInstance(DateDto, { value }).value).toEqual(expected);
    expect(instanceToPlain(Object.assign(new DateDto(), { value })).value).toEqual(expected);
  });

  it('无效 Date 不转换成日期字符串', () => {
    const value = new Date(Number.NaN);
    expect(formatDateValue(value)).toBe(value);
    expect((plainToInstance(DateDto, { value }).value as Date).getTime()).toBeNaN();
    expect((instanceToPlain(Object.assign(new DateDto(), { value })).value as Date).getTime()).toBeNaN();
  });

  it('支持自定义格式', () => {
    class CustomDateDto {
      @DateFormat('YYYY/MM/DD HH:mm')
      value: unknown;
    }

    const value = '2026-10-20T20:30:00Z';
    expect(formatDateValue(value, 'YYYY/MM/DD HH:mm')).toBe('2026/10/21 04:30');
    expect(plainToInstance(CustomDateDto, { value }).value).toBe('2026/10/21 04:30');
  });
});
