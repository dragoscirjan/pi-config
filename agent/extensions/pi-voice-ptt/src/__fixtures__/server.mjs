import { createServer } from 'node:http';
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const model = value('--model');
const prefix = value('--request-path');
const gpu = model === 'ignore-cpu' || (model.startsWith('gpu') && !args.includes('--no-gpu'));
if (model === 'crash') process.exit(1);
if (gpu) console.error('whisper_backend_init_gpu: using Vulkan0 backend\nggml_vulkan: 0 = Test hardware GPU');
else console.error('whisper_backend_init_gpu: no GPU found');
let active = 0;
createServer(async (req, res) => {
  if (req.url === prefix + '/health') {
    res.writeHead(model === 'slow' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: model === 'slow' ? 'loading model' : 'ok' }));
    return;
  }
  if (req.url !== prefix + '/inference') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (model === 'hang') return;
  if (model === 'http-error') {
    res.writeHead(500);
    res.end();
    return;
  }
  active++;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const form = await new Response(Buffer.concat(chunks), {
    headers: { 'Content-Type': req.headers['content-type'] },
  }).formData();
  const file = form.get('file');
  const wav = Buffer.from(await file.arrayBuffer());
  const text = `${form.get('language')}|${wav.toString('ascii', 0, 4)}|${wav.readUInt32LE(24)}|${wav.readInt16LE(44)}|active=${active}`;
  await new Promise((resolve) => setTimeout(resolve, 20));
  active--;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(model === 'bad-json' ? {} : { text }));
}).listen(Number(value('--port')), value('--host'));
