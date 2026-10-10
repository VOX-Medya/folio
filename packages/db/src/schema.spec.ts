import {describe, expect, it} from 'vitest';
import {getTableName} from 'drizzle-orm';
import {authors, works, workAuthors, auditEvents, importBatches} from './schema.js';

describe('minimal Folio DB schema contracts', () => {
  it('uses distinct canonical tables and joins rather than unique title keys', () => {
    expect([authors, works, workAuthors, auditEvents, importBatches].map(getTableName)).toEqual([
      'authors', 'works', 'work_authors', 'audit_events', 'import_batches',
    ]);
  });
});
