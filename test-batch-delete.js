const createCacheClient = require('./sdk/cache-client');

async function testBatchDelete() {
  const client = createCacheClient({
    url: 'http://localhost:3000',
    apiKey: 'djfhskjfdkf1fdfg4d2g4sd2fg54sd2fg4d2fg',
    namespace: 'test-del'
  });

  console.log('--- TEST BATCH DELETE ---');

  // 1. Setup keys
  await client.setMany([
    { key: 'd1', value: 1 },
    { key: 'd2', value: 2 },
    { key: 'd3', value: 3 }
  ]);
  console.log('Keys set: d1, d2, d3');

  // 2. Batch Delete
  const res = await client.deleteMany(['d1', 'd2', 'd3']);
  console.log('Batch Delete result:', res);

  // 3. Verify
  const verify = await client.getMany(['d1', 'd2', 'd3']);
  console.log('Verification (should be null):', verify);

  if (res.deleted === 3 && verify.d1 === null) {
    console.log('✅ TEST PASSED');
  } else {
    console.log('❌ TEST FAILED');
  }
}

testBatchDelete().catch(console.error);
