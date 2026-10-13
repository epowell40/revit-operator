import assert from 'node:assert/strict';
import test from 'node:test';
import { pdfDocumentNavigation } from '../src/attachments/pdf_document_navigation.js';

test('catalog retains page order and declared labels without inferring native identity', () => {
  const catalog = pdfDocumentNavigation(4, ['E000 - Cover\0', 'E001 - Index', null, 'E010 - Distribution']);
  assert.deepEqual(catalog.pages, [
    { page: 1, declared_pdf_page_label: 'E000 - Cover' },
    { page: 2, declared_pdf_page_label: 'E001 - Index' },
    { page: 3, declared_pdf_page_label: null },
    { page: 4, declared_pdf_page_label: 'E010 - Distribution' },
  ]);
  assert.equal(catalog.omitted_pages, 0);
  assert.match(catalog.notice, /not confirmed sheet\/view identities/);
  assert.match(catalog.notice, /does not establish visual coverage/);
});
test('missing labels never fabricate a source sheet or hide unpreviewed work', () => {
  const catalog = pdfDocumentNavigation(8, null);
  assert.equal(catalog.pages.length, 8);
  assert(catalog.pages.every(p => p.declared_pdf_page_label === null));
  assert.match(catalog.notice, /may still contain marks/);
});
test('catalog bounds huge documents and malformed labels with explicit omission', () => {
  const catalog = pdfDocumentNavigation(500, ['A'.repeat(500), { fake: 'E010' }]);
  assert.equal(catalog.pages.length, 256);
  assert.equal(catalog.omitted_pages, 244);
  assert.equal(catalog.pages[0]!.declared_pdf_page_label!.length, 120);
  assert.equal(catalog.pages[1]!.declared_pdf_page_label, null);
  assert.deepEqual(pdfDocumentNavigation(500, ['A'.repeat(500), { fake: 'E010' }]), catalog);
});
test('catalog rejects invalid counts', () => {
  for (const count of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => pdfDocumentNavigation(count, null));
});
