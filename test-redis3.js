const { createClient } = require('redis');
async function test() {
    const client = createClient();
    await client.connect();
    
    // pipeline test
    const pipeline = client.multi();
    pipeline.exists(['a']);
    try {
        await pipeline.exec();
        console.log("pipeline.exists array worked");
    } catch(e) {
        console.log("pipeline.exists array failed:", e.message);
    }
    
    // sRem array test
    const pipeline2 = client.multi();
    pipeline2.sRem('myset', ['a']);
    try {
        await pipeline2.exec();
        console.log("pipeline.sRem array worked");
    } catch(e) {
        console.log("pipeline.sRem array failed:", e.message);
    }
    
    // what about client.sRem with array?
    try {
        await client.sRem('myset3', ['a', 'b']);
        console.log("client.sRem array worked");
    } catch (e) {
        console.log("client.sRem array failed:", e.message);
    }
    
    await client.disconnect();
}
test();
