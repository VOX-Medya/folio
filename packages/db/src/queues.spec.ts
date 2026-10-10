import {describe,expect,it} from 'vitest';
import {folioQueueNames,folioJobPolicy,folioDeadLetter,isFolioQueueName} from './queues.js';

describe('bounded persistent V1 worker queue policy',()=>{
  it('contains only V1 import, parsing, cover and asset-validation jobs',()=>{
    expect(folioQueueNames).toEqual(['folio.import.validate','folio.book.parse','folio.cover.render','folio.media.validate']);
    expect(new Set(folioQueueNames).size).toBe(4);
    expect(isFolioQueueName('folio.tts.generate')).toBe(false);
    expect(isFolioQueueName('folio.book.parse')).toBe(true);
  });
  it('requires retry limits, expiration and separate non-retrying dead-letter queues',()=>{
    expect(folioJobPolicy.retryLimit).toBeGreaterThan(0);
    expect(folioJobPolicy.retryLimit).toBeLessThanOrEqual(3);
    expect(folioJobPolicy.expireInSeconds).toBeGreaterThan(0);
    expect(folioJobPolicy.retryBackoff).toBe(true);
    expect(folioJobPolicy.retryDelayMax).toBeLessThanOrEqual(folioJobPolicy.expireInSeconds);
    for (const name of folioQueueNames) expect(folioDeadLetter(name)).toBe(`${name}.dead`);
  });
});
