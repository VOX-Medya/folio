import { describe, expect, it } from 'vitest';
import config from '../app.json';

describe('cross-platform application configuration', () => {
  it('uses the shared Expo Router entry and web Metro bundle', () => {
    expect(config.expo.slug).toBe('folio');
    expect(config.expo.scheme).toBe('folio');
    expect(config.expo.web.bundler).toBe('metro');
    expect(config.expo.plugins).toContain('expo-router');
    expect(config.expo.experiments.typedRoutes).toBe(true);
  });
});
