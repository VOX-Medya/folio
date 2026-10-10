import { describe, expect, it } from 'vitest';
import { breakpoints, interaction, paperbound, radii, responsiveMode, typography } from './index.js';

function luminance(hex: string): number {
  const values = hex.slice(1).match(/.{2}/g)?.map(h => parseInt(h, 16) / 255);
  if (!values || values.length !== 3) throw new Error('Invalid color');
  const [r, g, b] = values.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('Paperbound design contract', () => {
  it('matches design reference color values', () => {
    expect(paperbound.mobile.light.bg).toBe('#F5F0E7');
    expect(paperbound.mobile.light.accent).toBe('#4F6955');
    expect(paperbound.admin.light.bg).toBe('#F6F4ED');
    expect(paperbound.admin.light.accent).toBe('#476E54');
    expect(radii).toMatchObject({ mobile: 21, admin: 17 });
  });
  it('gives principal text and action buttons WCAG AA contrast', () => {
    for (const platform of [paperbound.mobile, paperbound.admin]) {
      for (const palette of [platform.light, platform.dark]) {
        expect(ratio(palette.ink, palette.bg)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(palette.ink, palette.surface)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(palette.accentOn, palette.accent)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('has responsive breakpoints and safe interaction target sizing', () => {
    expect([320, 390, 599, 600, 768, 1023, 1024, 1440, 1920].map(responsiveMode)).toEqual([
      'phone', 'phone', 'phone', 'tablet', 'tablet', 'tablet', 'desktop', 'desktop', 'desktop',
    ]);
    expect(() => responsiveMode(-1)).toThrow(RangeError);
    expect(breakpoints.tablet).toBe(600);
    expect(interaction.minTouchTarget).toBeGreaterThanOrEqual(44);
    expect(typography.readerMaxCharacters).toBeLessThanOrEqual(80);
  });
});
