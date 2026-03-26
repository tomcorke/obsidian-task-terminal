// CDP helper - evaluates JS in Obsidian's renderer process
// Usage: node cdp.js '<expression>'
const http = require('http');
const crypto = require('crypto');

const TARGET_ID = '0435B9231441206FCEDD8CEE82BA7E8E';
const expr = process.argv[2];
if (!expr) { console.error('Usage: node cdp.js "<expression>"'); process.exit(1); }

function cdpEval(expression) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: 'localhost', port: 9222,
      path: `/devtools/page/${TARGET_ID}`,
      method: 'GET',
      headers: {
        'Upgrade': 'websocket', 'Connection': 'Upgrade',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      }
    });

    req.on('upgrade', (res, socket) => {
      const msg = JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression, returnByValue: true, awaitPromise: true}});
      const payload = Buffer.from(msg);
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, masked]));

      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2) return;
        const len0 = buf[1] & 0x7f;
        let payloadStart = 2, payloadLen = len0;
        if (len0 === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); payloadStart = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); payloadStart = 10; }
        if (buf.length < payloadStart + payloadLen) return;
        const data = buf.slice(payloadStart, payloadStart + payloadLen).toString();
        socket.destroy();
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });

    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
}

cdpEval(expr).then(r => {
  const val = r?.result?.result;
  if (val?.type === 'string') console.log(val.value);
  else if (val?.value !== undefined) console.log(JSON.stringify(val.value, null, 2));
  else console.log(JSON.stringify(r?.result || r, null, 2));
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
