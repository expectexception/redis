const { createClient } = require('redis');
require('dotenv').config();

async function check() {
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    
    try {
        const info = await client.info('memory');
        console.log('Memory Info:\n', info);
        
        try {
            const defrag = await client.configGet('activedefrag');
            console.log('Active Defrag Config:', defrag);
        } catch (e) {
            console.log('Cannot get activedefrag config:', e.message);
        }
        
        console.log('Triggering MEMORY PURGE...');
        const res = await client.sendCommand(['MEMORY', 'PURGE']);
        console.log('Purge result:', res);
        
    } catch (err) {
        console.error(err);
    } finally {
        await client.quit();
    }
}

check();
