const createCacheClient = require('./sdk/cache-client');

async function runBenchmark() {
  const client = createCacheClient({
    url: 'http://localhost:3000',
    apiKey: 'djfhskjfdkf1fdfg4d2g4sd2fg54sd2fg4d2fg',
    namespace: 'bench'
  });

  console.log('--- START BENCHMARK ---');

  // 1. Single SETs
  const startSet = Date.now();
  for (let i = 0; i < 100; i++) {
    await client.set(`key:${i}`, { data: 'test' });
  }
  console.log(`100 SETs: ${Date.now() - startSet}ms`);

  // 2. Single GETs
  const startGet = Date.now();
  for (let i = 0; i < 100; i++) {
    await client.get(`key:${i}`);
  }
  console.log(`100 GETs: ${Date.now() - startGet}ms`);

  // 3. Batch SET
  const startBatchSet = Date.now();
  const entries = Array.from({ length: 100 }, (_, i) => ({ key: `batch:${i}`, value: { data: 'batch' } }));
  await client.setMany(entries);
  console.log(`Batch SET (100 keys): ${Date.now() - startBatchSet}ms`);

  // 4. Batch GET
  const startBatchGet = Date.now();
  const keys = Array.from({ length: 100 }, (_, i) => `batch:${i}`);
  await client.getMany(keys);
  console.log(`Batch GET (100 keys): ${Date.now() - startBatchGet}ms`);

  console.log('--- END BENCHMARK ---');
}

runBenchmark().catch(console.error);
