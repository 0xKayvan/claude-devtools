import { describe, expect, it } from 'vitest';

import {
  isSessionIdFragment,
  isUUID,
  MIN_FRAGMENT_LENGTH,
  SESSION_FRAGMENT_REGEX,
  UUID_REGEX,
} from '../../../src/shared/utils/sessionIdValidator';

describe('sessionIdValidator', () => {
  describe('isUUID', () => {
    it('accepts a valid v4 UUID', () => {
      expect(isUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('accepts uppercase UUID', () => {
      expect(isUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('trims surrounding whitespace', () => {
      expect(isUUID('  550e8400-e29b-41d4-a716-446655440000  ')).toBe(true);
    });

    it('rejects a partial UUID (too short)', () => {
      expect(isUUID('550e8400-e29b')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isUUID('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isUUID('')).toBe(false);
    });
  });

  describe('isSessionIdFragment', () => {
    it('accepts exact minimum length (3 chars)', () => {
      expect(isSessionIdFragment('abc')).toBe(true);
    });

    it('rejects 2 chars (below minimum)', () => {
      expect(isSessionIdFragment('ab')).toBe(false);
    });

    it('accepts hex-with-dashes', () => {
      expect(isSessionIdFragment('abc-def')).toBe(true);
    });

    it('rejects a full UUID', () => {
      expect(isSessionIdFragment('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isSessionIdFragment('xyz')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isSessionIdFragment('')).toBe(false);
    });

    it('trims surrounding whitespace', () => {
      expect(isSessionIdFragment('  abc  ')).toBe(true);
    });
  });

  describe('exported constants', () => {
    it('exports UUID_REGEX as a RegExp', () => {
      expect(UUID_REGEX).toBeInstanceOf(RegExp);
    });

    it('exports SESSION_FRAGMENT_REGEX as a RegExp', () => {
      expect(SESSION_FRAGMENT_REGEX).toBeInstanceOf(RegExp);
    });

    it('exports MIN_FRAGMENT_LENGTH as 3', () => {
      expect(MIN_FRAGMENT_LENGTH).toBe(3);
    });
  });
});
