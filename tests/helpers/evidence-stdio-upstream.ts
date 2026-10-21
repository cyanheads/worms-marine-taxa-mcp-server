/**
 * @fileoverview Strict process-local upstream fake for the real stdio integration lane.
 * @module tests/helpers/evidence-stdio-upstream
 */
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://www.marinespecies.org')
    throw new Error(`Unexpected origin: ${url.origin}`);
  if (
    url.pathname === '/rest/AphiaAttributesByAphiaID/1' &&
    url.searchParams.get('include_inherited') === 'true'
  ) {
    return Response.json([
      {
        measurementTypeID: '001',
        measurementValue: 'A\r\n\n`|<>',
        children: [{ source_id: '002', reference: 'https://example.org/a_(b)?x=1&y=2' }],
      },
    ]);
  }
  throw new Error(`Unexpected upstream request: ${url.pathname}${url.search}`);
};
