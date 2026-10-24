/**
 * @fileoverview Strict process-local upstream fake for the real stdio integration lane.
 * @module tests/helpers/evidence-stdio-upstream
 */
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://www.marinespecies.org')
    throw new Error(`Unexpected origin: ${url.origin}`);
  if (url.pathname === '/rest/AphiaRecordByAphiaID/1' && !url.search)
    return Response.json({ AphiaID: 1, status: 'accepted', valid_AphiaID: 1 });
  if (url.pathname === '/rest/AphiaRecordsByAphiaIDs') {
    const ids = url.searchParams.getAll('aphiaids[]');
    if (ids.some((id) => id !== '1')) throw new Error('Expected normalized numeric IDs.');
    return Response.json(ids.map(() => ({ AphiaID: 1 })));
  }
  if (url.pathname === '/rest/AphiaRecordsByNames') {
    if (url.searchParams.getAll('scientificnames[]').join() !== 'Gadus morhua')
      throw new Error('Expected repaired name container.');
    return Response.json([[{ AphiaID: 1 }]]);
  }
  if (url.pathname === '/rest/AphiaClassificationByAphiaID/1')
    return Response.json({ AphiaID: 2, child: { AphiaID: 1 } });
  if (
    url.pathname === '/rest/AphiaSynonymsByAphiaID/1' ||
    url.pathname === '/rest/AphiaDistributionsByAphiaID/1' ||
    url.pathname === '/rest/AphiaExternalIDByAphiaID/1'
  )
    return Response.json([]);
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
