/** Stable source catalog, not an inferred model locator or a review receipt. */
export function pdfDocumentNavigation(pageCount: number, labels: readonly unknown[] | null) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('Invalid PDF page count.');
  const listed = Math.min(pageCount, 256);
  return {
    page_count: pageCount,
    pages: Array.from({ length: listed }, (_, index) => ({
      page: index + 1,
      declared_pdf_page_label: typeof labels?.[index] === 'string'
        ? String(labels[index]).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : null,
    })),
    omitted_pages: pageCount - listed,
    notice: 'Declared PDF labels are navigation hints, not confirmed sheet/view identities. Review the relevant full-page overview or titleblock detail and resolve the native sheet/view before changing the model. Unpreviewed or unlabelled pages may still contain marks. Request any page and detail region with operator_read_attachment; this catalog does not establish visual coverage.',
  };
}
