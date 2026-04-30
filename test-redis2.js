const { createClient } = require('redis');
async function test() {
    const client = createClient();
    await client.connect();
    await client.sAdd('myset2', ['a']);
    try {
        await client.sRem('myset2', ['a']);
        console.log("Array with 1 worked");
    } catch (e) {
        console.log("Array with 1 failed:", e.message);
    }
    await client.disconnect();
}
test();
