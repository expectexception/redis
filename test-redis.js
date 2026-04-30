const { createClient } = require('redis');
async function test() {
    const client = createClient();
    await client.connect();
    await client.sAdd('myset', ['a', 'b', 'c']);
    try {
        await client.sRem('myset', ['a', 'b']);
        console.log("Array worked");
    } catch (e) {
        console.log("Array failed:", e.message);
    }
    try {
        await client.sRem('myset', 'a', 'b');
        console.log("Spread worked");
    } catch (e) {
        console.log("Spread failed:", e.message);
    }
    await client.disconnect();
}
test();
