import { describe, expect, it } from 'vitest';
import { HealthController } from './main.js';
describe('health', () => { it('reports ok', () => expect(new HealthController().health()).toEqual({status:'ok'})); });
